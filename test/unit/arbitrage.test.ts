import {ethers} from 'hardhat';
import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES} from '../shared/dexes';
import {ExecutorMode, ONE, RouterMode, Stack, armArbitrage, balanceOf, createPool, events, fixtureFor, swap} from '../shared/stack';

const PROFIT = 10n ** 15n;

for (const dex of DEXES) {
	describe(`${dex.hookName}: backrun and profit split`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		async function backrun(s: Stack, opts: {native?: boolean; userZeroForOne?: boolean; lpShareBps?: number; profitToken?: string} = {}) {
			const pool = await createPool(s, 10, {native: opts.native});
			const userZeroForOne = opts.userZeroForOne ?? true;
			if (opts.lpShareBps !== undefined) await (await s.hook.setLpShareBps(pool.poolId, opts.lpShareBps)).wait();
			await armArbitrage(s, pool, userZeroForOne, {profit: PROFIT, profitToken: opts.profitToken});
			const token = opts.profitToken ?? pool.key.currency0;
			const distributorBefore = await balanceOf(token, s.distributor.target as string);
			const managerBalanceBefore = await balanceOf(token, (s.vault ?? s.manager).target as string);
			const r = await swap(s, pool, userZeroForOne);
			return {pool, r, token, distributorBefore, managerBalanceBefore};
		}

		it('backruns a user swap: the executor swaps back at zero fee, half the profit is donated to the LPs, half goes to the distributor', async () => {
			const s = await setup();
			const {pool, r, token, distributorBefore} = await backrun(s);

			const swaps = events(s.manager, r, 'Swap');
			expect(swaps.map((e) => e.args.sender)).to.deep.equal([s.testRouter.target, s.executor.target]);
			expect(swaps.map((e) => e.args.fee)).to.deep.equal([500n, 0n]);

			const shared = events(s.hook, r, 'ProfitShared');
			expect(shared.length).to.equal(1);
			expect(shared[0].args).to.deep.equal([pool.poolId, token, PROFIT / 2n, PROFIT / 2n]);
			expect(events(s.hook, r, 'BackrunFailed').length).to.equal(0);
			const donations = events(s.manager, r, 'Donate');
			expect(donations.length).to.equal(1);
			expect([donations[0].args.sender, donations[0].args.amount0, donations[0].args.amount1]).to.deep.equal([s.hook.target, PROFIT / 2n, 0n]);

			expect((await balanceOf(token, s.distributor.target as string)) - distributorBefore).to.equal(PROFIT / 2n);
			expect(await s.distributor.calls()).to.equal(1n);
			expect(await s.distributor.lastConfigId()).to.equal(pool.poolId);
			expect(await s.distributor.lastToken()).to.equal(token);
			expect(await s.distributor.lastSwapRecipient()).to.equal(s.testRouter.target); // the pool manager caller
			expect(await balanceOf(token, s.hook.target as string)).to.equal(0n);
		});

		it('hands the router the backrun direction and the amounts the pool received (+) and paid (-)', async () => {
			const s = await setup();
			const {r} = await backrun(s, {userZeroForOne: true});
			const [userSwap] = events(s.manager, r, 'Swap');
			expect(await s.mevxRouter.lastConstructZeroToOne()).to.equal(true); // the user's direction
			expect(await s.mevxRouter.lastConstructArbData()).to.equal('0x1234567890abcdef1234567890abcdef');
			expect(await s.mevxRouter.lastAmount0()).to.equal(-userSwap.args.amount0);
			expect(await s.mevxRouter.lastAmount1()).to.equal(-userSwap.args.amount1);
			expect(await s.mevxRouter.lastAmount0()).to.equal(ONE);
			expect(await s.mevxRouter.lastAmount1()).to.be.lessThan(0n);
		});

		it('the executor swap does not start another backrun; the hook only lets the router see the new price', async () => {
			const s = await setup();
			await backrun(s);
			expect(await s.mevxRouter.constructCalls()).to.equal(1n);
			expect(await s.mevxRouter.checkCalls()).to.equal(2n); // user swap, then executor swap (opposite direction)
			expect(await s.mevxRouter.lastCheckZeroToOne()).to.equal(true);
		});

		it('works in the other direction with the profit in currency1', async () => {
			const s = await setup();
			const token1 = await s.token1.getAddress();
			const {pool, r} = await backrun(s, {userZeroForOne: false, profitToken: token1});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, token1, PROFIT / 2n, PROFIT / 2n]);
			const [d] = events(s.manager, r, 'Donate');
			expect([d.args.amount0, d.args.amount1]).to.deep.equal([0n, PROFIT / 2n]);
		});

		it('LP share 0: everything to the distributor, no donation', async () => {
			const s = await setup();
			const {pool, r, token} = await backrun(s, {lpShareBps: 0});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, token, 0n, PROFIT]);
			expect(events(s.manager, r, 'Donate').length).to.equal(0);
		});

		it('LP share 100%: everything donated, the distributor is not called', async () => {
			const s = await setup();
			const {pool, r, token, distributorBefore} = await backrun(s, {lpShareBps: 10_000});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, token, PROFIT, 0n]);
			expect(await s.distributor.calls()).to.equal(0n);
			expect(await balanceOf(token, s.distributor.target as string)).to.equal(distributorBefore);
		});

		it('rounds the LP share down, the remainder goes to the distributor', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setLpShareBps(pool.poolId, 3333)).wait();
			await armArbitrage(s, pool, true, {profit: 1001n});
			const r = await swap(s, pool, true);
			expect(events(s.hook, r, 'ProfitShared')[0].args.slice(2)).to.deep.equal([333n, 668n]);
		});

		it('a profit token outside the pool cannot be donated: all of it goes to the distributor', async () => {
			const s = await setup();
			const other = await s.other.getAddress();
			const {pool, r} = await backrun(s, {profitToken: other});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, other, 0n, PROFIT]);
			expect(events(s.manager, r, 'Donate').length).to.equal(0);
		});

		it('native currency pool and native profit: donated through the vault/manager in native, the rest sent to the distributor', async () => {
			const s = await setup();
			const {pool, r, distributorBefore} = await backrun(s, {native: true, profitToken: ethers.ZeroAddress});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, ethers.ZeroAddress, PROFIT / 2n, PROFIT / 2n]);
			const [d] = events(s.manager, r, 'Donate');
			expect([d.args.amount0, d.args.amount1]).to.deep.equal([PROFIT / 2n, 0n]);
			expect((await balanceOf(ethers.ZeroAddress, s.distributor.target as string)) - distributorBefore).to.equal(PROFIT / 2n);
			expect(await s.distributor.lastToken()).to.equal(ethers.ZeroAddress);
			expect(await ethers.provider.getBalance(s.hook.target)).to.equal(0n);
		});

		it('native currency pool, user selling native: backrun in the other direction', async () => {
			const s = await setup();
			const token1 = await s.token1.getAddress();
			const {pool, r} = await backrun(s, {native: true, userZeroForOne: true, profitToken: token1});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, token1, PROFIT / 2n, PROFIT / 2n]);
		});

		it('the donated profit is earned by the LPs in range', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setLpShareBps(pool.poolId, 10_000)).wait();
			await armArbitrage(s, pool, true, {profit: 10n ** 18n, amountIn: 0n});
			const t0 = await s.token0.getAddress();
			const managerBefore = await balanceOf(t0, (s.vault ?? s.manager).target as string);
			await swap(s, pool, true);
			// the user paid 1 token0 in, the donation added 1 token0 more: all of it stays with the pool's liquidity
			expect((await balanceOf(t0, (s.vault ?? s.manager).target as string)) - managerBefore).to.equal(2n * ONE);
		});
	});

	describe(`${dex.hookName}: backrun failures never block the user swap`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		async function userSwapWith(s: Stack, configure: (pool: any) => Promise<void>) {
			const pool = await createPool(s, 10);
			await armArbitrage(s, pool, true, {profit: PROFIT});
			await configure(pool);
			const r = await swap(s, pool, true);
			expect(r.status).to.equal(1);
			return {pool, r};
		}

		it('no arbitrage: the executor is not called', async () => {
			const s = await setup();
			const {r} = await userSwapWith(s, async () => {
				await (await s.mevxRouter.setArbitrage(false, '0x' + '00'.repeat(16), ethers.ZeroAddress, 0, '0x')).wait();
			});
			expect(await s.mevxRouter.constructCalls()).to.equal(0n);
			expect(events(s.manager, r, 'Swap').length).to.equal(1);
			expect(events(s.hook, r, 'ProfitShared').length).to.equal(0);
			expect(events(s.hook, r, 'BackrunFailed').length).to.equal(0);
		});

		it('the router finds no route', async () => {
			const s = await setup();
			const {r} = await userSwapWith(s, async () => {
				await (await s.mevxRouter.setRoutePossible(false)).wait();
			});
			expect(events(s.manager, r, 'Swap').length).to.equal(1);
			expect(events(s.hook, r, 'ProfitShared').length).to.equal(0);
		});

		// initialArbCheck failing counts as "no arbitrage"; a failure once an arbitrage was found is reported
		for (const [what, modes, reported] of [
			['initialArbCheck reverts', [RouterMode.Normal, RouterMode.Revert, RouterMode.Normal], false],
			['initialArbCheck burns its gas', [RouterMode.Normal, RouterMode.BurnGas, RouterMode.Normal], false],
			['constructArbitrageRoute reverts', [RouterMode.Normal, RouterMode.Normal, RouterMode.Revert], true],
			['constructArbitrageRoute burns its gas', [RouterMode.Normal, RouterMode.Normal, RouterMode.BurnGas], true],
		] as const)
			it(`the router fails: ${what}`, async () => {
				const s = await setup();
				const {pool, r} = await userSwapWith(s, async (pool) => {
					await (await s.mevxRouter.setModes(...modes)).wait();
					await (await s.hook.setCallGasBudget(pool.poolId, 1_000_000)).wait();
				});
				expect(events(s.manager, r, 'Swap').length).to.equal(1);
				expect(events(s.hook, r, 'ProfitShared').length).to.equal(0);
				const failed = events(s.hook, r, 'BackrunFailed');
				expect(failed.map((e) => [...e.args])).to.deep.equal(reported ? [[pool.poolId, false, false]] : []);
			});

		for (const [what, mode] of [
			['reverts', ExecutorMode.Revert],
			['reports the route as not executed', ExecutorMode.NotExecuted],
			['burns its gas', ExecutorMode.BurnGas],
		] as const)
			it(`the executor ${what}`, async () => {
				const s = await setup();
				const {pool, r} = await userSwapWith(s, async (pool) => {
					await armArbitrage(s, pool, true, {profit: PROFIT, mode});
					await (await s.hook.setCallGasBudget(pool.poolId, 1_000_000)).wait();
				});
				expect(events(s.manager, r, 'Swap').length).to.equal(1);
				expect(events(s.hook, r, 'ProfitShared').length).to.equal(0);
				expect(events(s.hook, r, 'BackrunFailed').map((e) => [...e.args])).to.deep.equal([[pool.poolId, false, false]]);
				expect(await balanceOf(await s.token0.getAddress(), s.hook.target as string)).to.equal(0n);
			});

		it('the executor runs but brings no profit: nothing is shared', async () => {
			const s = await setup();
			const {r} = await userSwapWith(s, async (pool) => {
				await armArbitrage(s, pool, true, {profit: 0n});
			});
			expect(events(s.manager, r, 'Swap').length).to.equal(2);
			expect(events(s.hook, r, 'ProfitShared').length).to.equal(0);
		});

		it('the distributor reverts: its share is still transferred to it and the profit is reported', async () => {
			const s = await setup();
			const t0 = await s.token0.getAddress();
			const before = await balanceOf(t0, s.distributor.target as string);
			const {pool, r} = await userSwapWith(s, async () => {
				await (await s.distributor.setReverts(true)).wait();
			});
			expect(events(s.hook, r, 'ProfitShared')[0].args).to.deep.equal([pool.poolId, t0, PROFIT / 2n, PROFIT / 2n]);
			expect((await balanceOf(t0, s.distributor.target as string)) - before).to.equal(PROFIT / 2n);
			expect(await s.distributor.calls()).to.equal(0n);
		});

		it('a router swapped by the admin takes effect for the next swap', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const other: any = await (await ethers.getContractFactory('MockMevxRouter', s.deployer)).deploy();
			await (await s.hook.setMevxRouter(other.target)).wait();
			await swap(s, pool, true);
			expect(await other.checkCalls()).to.equal(1n);
			expect(await s.mevxRouter.checkCalls()).to.equal(0n);
		});
	});
}
