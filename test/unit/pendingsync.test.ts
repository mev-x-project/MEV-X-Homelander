import {ethers} from 'hardhat';
import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES} from '../shared/dexes';
import {ExecutorMode, ONE, Pool, Stack, armArbitrage, balanceOf, createPool, events, fixtureFor} from '../shared/stack';

const PROFIT = 10n ** 15n;

enum Evil {
	None,
	RevertTransfer,
	BurnGasTransfer,
	RevertBalanceOf,
	CallOnTransfer,
}

type HoldOpts = {zeroForOne?: boolean; amount?: bigint; payBefore?: boolean; extra?: bigint; hold?: string};

for (const dex of DEXES) {
	describe(`${dex.hookName}: a caller that keeps a currency synced across the swap`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		async function holdingRouter(s: Stack, extraTokens: any[] = []) {
			const router: any = s.vault
				? await (await ethers.getContractFactory('PancakeSyncHoldingRouter')).deploy(s.vault, s.manager)
				: await (await ethers.getContractFactory('UniV4SyncHoldingRouter')).deploy(s.manager);
			for (const t of [s.token0, s.token1, s.other, ...extraTokens]) await (await t.approve(router.target, ethers.MaxUint256)).wait();
			return router;
		}

		async function holdSwap(router: any, pools: Pool[], o: HoldOpts = {}) {
			const zeroForOne = o.zeroForOne ?? true;
			const amount = o.amount ?? ONE;
			const extra = o.extra ?? 0n;
			const order = {
				keys: pools.map((p) => p.key),
				zeroForOne,
				amountIn: amount,
				payBefore: o.payBefore ?? true,
				extra,
				hold: o.hold ?? ethers.ZeroAddress,
			};
			const nativeInput = zeroForOne && pools[0].key.currency0 === ethers.ZeroAddress;
			const value = nativeInput ? amount * BigInt(pools.length) + (o.hold ? 0n : extra) : 0n;
			return (await (await router.swap(order, {value, gasLimit: 15_000_000})).wait())!;
		}

		function shared(s: Stack, r: any) {
			return events(s.hook, r, 'ProfitShared').map((e) => [e.args.profitToken, e.args.donatedToLps, e.args.sentToDistributor]);
		}

		for (const payBefore of [true, false])
			for (const zeroForOne of [true, false])
				for (const profitIn of [0, 1])
					it(`backruns and donates; the caller's sync survives (pays ${payBefore ? 'before' : 'after'} the swap, sells token${zeroForOne ? 0 : 1}, profit in token${profitIn})`, async () => {
						const s = await setup();
						const pool = await createPool(s, 10);
						const router = await holdingRouter(s);
						const token = profitIn === 0 ? pool.key.currency0 : pool.key.currency1;
						await armArbitrage(s, pool, zeroForOne, {profit: PROFIT, profitToken: token});
						const r = await holdSwap(router, [pool], {zeroForOne, payBefore});
						expect(shared(s, r)).to.deep.equal([[token, PROFIT / 2n, PROFIT / 2n]]);
						expect(events(s.manager, r, 'Swap').map((e) => e.args.sender)).to.deep.equal([router.target, s.executor.target]);
						expect(await balanceOf(token, s.hook.target as string)).to.equal(0n);
					});

		it('native pool, the caller sells the token: the native donation goes through (the reported case)', async () => {
			const s = await setup();
			const pool = await createPool(s, 10, {native: true});
			const router = await holdingRouter(s);
			await armArbitrage(s, pool, false, {profit: PROFIT, profitToken: ethers.ZeroAddress});
			const r = await holdSwap(router, [pool], {zeroForOne: false});
			expect(shared(s, r)).to.deep.equal([[ethers.ZeroAddress, PROFIT / 2n, PROFIT / 2n]]);
			expect(events(s.manager, r, 'Donate').length).to.equal(1);
		});

		it('native pool, the caller pays native after the swap: nothing to restore, backrun and donation go through', async () => {
			const s = await setup();
			const pool = await createPool(s, 10, {native: true});
			const router = await holdingRouter(s);
			await armArbitrage(s, pool, true, {profit: PROFIT, profitToken: ethers.ZeroAddress});
			const r = await holdSwap(router, [pool], {zeroForOne: true, payBefore: false});
			expect(shared(s, r)).to.deep.equal([[ethers.ZeroAddress, PROFIT / 2n, PROFIT / 2n]]);
		});

		it('the caller is credited exactly what it paid, overpayment included, and takes the overpayment back', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const router = await holdingRouter(s);
			await armArbitrage(s, pool, true, {profit: PROFIT});
			const before = await balanceOf(pool.key.currency0, s.deployer.address);
			const r = await holdSwap(router, [pool], {extra: 12345n});
			expect(shared(s, r).length).to.equal(1);
			// the router requires settle() == amountIn + extra and takes extra back: the user paid exactly amountIn
			expect(before - (await balanceOf(pool.key.currency0, s.deployer.address))).to.equal(ONE);
		});

		it('a synced currency outside the pool (multi-hop caller) survives the backrun', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const router = await holdingRouter(s);
			await armArbitrage(s, pool, true, {profit: PROFIT});
			for (const payBefore of [true, false]) {
				const r = await holdSwap(router, [pool], {hold: s.other.target as string, extra: 777n, payBefore});
				expect(shared(s, r).length).to.equal(1);
			}
		});

		it('two pools of the hook under one sync: both are backrun and the sync survives both', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			const router = await holdingRouter(s);
			await armArbitrage(s, a, true, {profit: PROFIT});
			const r = await holdSwap(router, [a, b]);
			expect(shared(s, r).length).to.equal(2);
		});

		for (const [name, mode] of [
			['reverts', ExecutorMode.Revert],
			['reports not executed', ExecutorMode.NotExecuted],
			['burns its gas', ExecutorMode.BurnGas],
		] as const)
			it(`the executor ${name}: the swap completes and the sync survives`, async () => {
				const s = await setup();
				const pool = await createPool(s, 10);
				const router = await holdingRouter(s);
				await armArbitrage(s, pool, true, {profit: PROFIT, mode});
				const r = await holdSwap(router, [pool]);
				expect(shared(s, r).length).to.equal(0);
			});

		it('no arbitrage, or the wallet is on the backrun skip list: the swap completes', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const router = await holdingRouter(s);
			const r = await holdSwap(router, [pool]);
			expect(await s.mevxRouter.checkCalls()).to.equal(1n);
			expect(shared(s, r).length).to.equal(0);
			await armArbitrage(s, pool, true, {profit: PROFIT});
			await (await s.hook.setBackrunSkip(pool.poolId, s.deployer.address, true)).wait();
			const r2 = await holdSwap(router, [pool]);
			expect(shared(s, r2).length).to.equal(0);
		});

		describe('a synced token that misbehaves only reverts the caller own swap, never skips the backrun', () => {
			async function evilSetup() {
				const s = await setup();
				const pool = await createPool(s, 10);
				const evil: any = await (await ethers.getContractFactory('EvilERC20')).deploy();
				await (await evil.mint(s.deployer.address, 10n ** 24n)).wait();
				const router = await holdingRouter(s, [evil]);
				await armArbitrage(s, pool, true, {profit: PROFIT});
				const swapWithEvil = () => holdSwap(router, [pool], {hold: evil.target as string, extra: 1000n});
				return {s, pool, evil, swapWithEvil};
			}

			it('a well-behaved token: backrun and swap go through', async () => {
				const {s, swapWithEvil} = await evilSetup();
				expect(shared(s, await swapWithEvil()).length).to.equal(1);
			});

			for (const [name, mode] of [
				['its transfer from the hook reverts', Evil.RevertTransfer],
				['its transfer from the hook burns all gas', Evil.BurnGasTransfer],
				['its balanceOf reverts', Evil.RevertBalanceOf],
			] as const)
				it(`${name}: the whole swap reverts`, async () => {
					const {s, evil, swapWithEvil} = await evilSetup();
					await (await evil.arm(mode, s.hook.target, ethers.ZeroAddress, '0x')).wait();
					await expect(swapWithEvil()).to.be.reverted;
				});

			it('its transfer from the hook re-enters the pool manager and syncs another currency: only the caller own settle breaks', async () => {
				const {s, evil, swapWithEvil} = await evilSetup();
				const data = (s.vault ?? s.manager).interface.encodeFunctionData('sync', [s.token1.target]);
				await (await evil.arm(Evil.CallOnTransfer, s.hook.target, (s.vault ?? s.manager).target, data)).wait();
				await expect(swapWithEvil()).to.be.reverted;
			});

			it('its transfer from the hook re-enters the hook: the internal entry points are self only', async () => {
				const {s, pool, evil, swapWithEvil} = await evilSetup();
				const data = s.hook.interface.encodeFunctionData('donateAndSettle', [pool.key, 1, 0]);
				await (await evil.arm(Evil.CallOnTransfer, s.hook.target, s.hook.target, data)).wait();
				// the pool manager wraps the hook's revert (WrappedError): look for the reason in the revert data
				const reason = ethers.hexlify(ethers.toUtf8Bytes('self only')).slice(2);
				await swapWithEvil().then(
					() => expect.fail('the swap went through'),
					(e: any) => expect(JSON.stringify(e.data ?? e)).to.include(reason)
				);
			});
		});
	});
}
