import {ethers} from 'hardhat';
import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES} from '../shared/dexes';
import {FeeMode, createPool, events, fixtureFor, swap} from '../shared/stack';

const ZERO = ethers.ZeroAddress;

for (const dex of DEXES) {
	describe(`${dex.hookName}: fees`, () => {
		const setup = () => loadFixture(fixtureFor(dex));
		const swapFee = async (s: any, r: any) => events(s.manager, r, 'Swap').map((e) => e.args.fee as bigint);

		it('users pay the pool static fee, the executor zero', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			expect(await swapFee(s, await swap(s, pool, true))).to.deep.equal([500n]);
			await expect(s.hook.setPoolFee(pool.poolId, 1234)).to.emit(s.hook, 'PoolStaticFeeSet').withArgs(pool.poolId, 1234);
			expect(await swapFee(s, await swap(s, pool, false))).to.deep.equal([1234n]);
			expect(await s.hook.getFee(pool.poolId, s.executor.target, s.alice.address, true, -1)).to.equal(0n);
		});

		it('the executor pays zero even with an override or a dynamic fee for its address', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setFeeOverride(pool.poolId, s.executor.target, 5001)).wait();
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 9000)).wait();
			await (await s.hook.setDynamicFeeEnabled(pool.poolId, true)).wait();
			expect(await s.hook.getFee(pool.poolId, s.executor.target, s.executor.target, true, -1)).to.equal(0n);
		});

		it('overrides: tx.origin first, then the pool manager caller; an override of 0 is a zero fee; clearing restores the pool fee', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const router = s.testRouter.target as string;
			const fee = (sender: string, origin: string) => s.hook.getFee(pool.poolId, sender, origin, true, -1);

			await expect(s.hook.setFeeOverride(pool.poolId, router, 301)).to.emit(s.hook, 'FeeOverrideSet').withArgs(pool.poolId, router, 301);
			expect(await fee(router, s.alice.address)).to.equal(300n);
			await (await s.hook.setFeeOverride(pool.poolId, s.alice.address, 1)).wait();
			expect(await fee(router, s.alice.address)).to.equal(0n);
			expect(await fee(router, s.bob.address)).to.equal(300n);
			expect((await s.hook.poolConfig(pool.poolId)).overriddenFeeCount).to.equal(2n);

			expect(await swapFee(s, await swap(s, pool, true, {from: s.alice}))).to.deep.equal([0n]);
			expect(await swapFee(s, await swap(s, pool, true, {from: s.bob}))).to.deep.equal([300n]);

			await (await s.hook.setFeeOverride(pool.poolId, s.alice.address, 1)).wait(); // same value again: count unchanged
			expect((await s.hook.poolConfig(pool.poolId)).overriddenFeeCount).to.equal(2n);
			await (await s.hook.setFeeOverride(pool.poolId, s.alice.address, 0)).wait();
			await (await s.hook.setFeeOverride(pool.poolId, router, 0)).wait();
			await (await s.hook.setFeeOverride(pool.poolId, router, 0)).wait(); // clearing twice: count stays 0
			expect((await s.hook.poolConfig(pool.poolId)).overriddenFeeCount).to.equal(0n);
			expect(await fee(router, s.alice.address)).to.equal(500n);
		});

		it('overrides are per pool', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			await (await s.hook.setFeeOverride(a.poolId, s.alice.address, 1)).wait();
			expect(await s.hook.getFee(a.poolId, ZERO, s.alice.address, true, -1)).to.equal(0n);
			expect(await s.hook.getFee(b.poolId, ZERO, s.alice.address, true, -1)).to.equal(3000n);
		});

		it('dynamic fee: off by default; enabled while the router has no getDynamicFee keeps the static fee', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 4200)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(500n);
			await (await s.mevxRouter.setDynamicFee(FeeMode.None, 0)).wait();
			await expect(s.hook.setDynamicFeeEnabled(pool.poolId, true)).to.emit(s.hook, 'PoolDynamicFeeSet');
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(500n);
		});

		it('dynamic fee: from the router, clamped to the pool bounds, with the static fee as baseFee', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setDynamicFeeEnabled(pool.poolId, true)).wait();
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 4200)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(4200n);
			expect(await swapFee(s, await swap(s, pool, true))).to.deep.equal([4200n]);

			await (await s.hook.setDynamicFeeBounds(pool.poolId, 1000, 3000)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(3000n);
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 10)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(1000n);
			await (await s.mevxRouter.setDynamicFee(FeeMode.EchoMinPlusMax, 0)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(3000n);
			await (await s.mevxRouter.setDynamicFee(FeeMode.EchoBaseFee, 0)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(1000n); // 500 clamped up
		});

		it('dynamic fee: a router that reverts or burns its gas falls back to the static fee; overrides win over it', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setDynamicFeeEnabled(pool.poolId, true)).wait();
			await (await s.mevxRouter.setDynamicFee(FeeMode.Revert, 0)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(500n);
			await (await s.mevxRouter.setDynamicFee(FeeMode.BurnGas, 0)).wait();
			await (await s.hook.setCallGasBudget(pool.poolId, 200_000)).wait();
			const r = await swap(s, pool, true);
			expect(await swapFee(s, r)).to.deep.equal([500n]);
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 4000)).wait();
			await (await s.hook.setFeeOverride(pool.poolId, s.deployer.address, 1)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, s.deployer.address, true, -1)).to.equal(0n);
		});

		it('every LP fee is capped at 10%: static, per tick spacing, default, per-address and dynamic', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			const MAX = 100_000n;
			expect(await s.hook.MAX_LP_FEE()).to.equal(MAX);
			expect(await s.hook.defaultDynamicFeeMax()).to.equal(MAX);
			expect((await s.hook.poolConfig(pool.poolId)).dynamicFeeMax).to.equal(MAX);

			await (await s.hook.setPoolFee(pool.poolId, MAX)).wait();
			await expect(s.hook.setPoolFee(pool.poolId, MAX + 1n)).to.be.revertedWith('invalid fee');
			await (await s.hook.setFeeForTickSpacing(10, MAX)).wait();
			await expect(s.hook.setFeeForTickSpacing(10, MAX + 1n)).to.be.revertedWith('invalid fee');
			await (await s.hook.setDefaults(MAX, 0, 1, false, 0, MAX)).wait();
			await expect(s.hook.setDefaults(MAX + 1n, 0, 1, false, 0, MAX)).to.be.revertedWith('invalid fee');
			await expect(s.hook.setDefaults(MAX, 0, 1, false, 0, MAX + 1n)).to.be.revertedWith('invalid bounds');
			await (await s.hook.setFeeOverride(pool.poolId, ZERO, MAX + 1n)).wait(); // stored as fee + 1
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(MAX);
			await expect(s.hook.setFeeOverride(pool.poolId, ZERO, MAX + 2n)).to.be.revertedWith('invalid fee');
			await (await s.hook.setDynamicFeeBounds(pool.poolId, 0, MAX)).wait();
			await expect(s.hook.setDynamicFeeBounds(pool.poolId, 0, MAX + 1n)).to.be.revertedWith('invalid bounds');
		});

		it('a dynamic fee above 10% from the fee source is clamped to 10%, also in a swap', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await (await s.hook.setDynamicFeeEnabled(pool.poolId, true)).wait();
			await (await s.mevxRouter.setDynamicFee(FeeMode.Fixed, 900_000)).wait();
			expect(await s.hook.getFee(pool.poolId, ZERO, ZERO, true, -1)).to.equal(100_000n);
			expect(await swapFee(s, await swap(s, pool, true))).to.deep.equal([100_000n]);
		});

		it('rejects inverted bounds and unknown pools', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await expect(s.hook.setDynamicFeeBounds(pool.poolId, 3000, 2000)).to.be.revertedWith('invalid bounds');
			await expect(s.hook.setPoolFee(ethers.id('unknown'), 100)).to.be.revertedWith('unknown pool');
			await expect(s.hook.setLpShareBps(ethers.id('unknown'), 100)).to.be.revertedWith('unknown pool');
		});
	});
}
