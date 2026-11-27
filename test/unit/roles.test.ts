import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES} from '../shared/dexes';
import {BACKRUN_SKIP_ROLE, FEE_MANAGER_ROLE, HARD_MODE_SKIP_ROLE, POOL_ADMIN_ROLE, createPool, fixtureFor} from '../shared/stack';

const MISSING_ROLE = /AccessControl: account .* is missing role/;

for (const dex of DEXES) {
	describe(`${dex.hookName}: roles`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		it('a stranger can set nothing', async () => {
			const s = await setup();
			const {poolId} = await createPool(s);
			const h: any = s.hook.connect(s.alice);
			for (const call of [
				() => h.setPoolFee(poolId, 1),
				() => h.setFeeOverride(poolId, s.bob.address, 1),
				() => h.setDynamicFeeEnabled(poolId, true),
				() => h.setDynamicFeeBounds(poolId, 0, 1),
				() => h.setLpShareBps(poolId, 1),
				() => h.setHardMode(poolId, true),
				() => h.setCallGasBudget(poolId, 1),
				() => h.setOutOfGasDepth(poolId, 1),
				() => h.setBackrunSkip(poolId, s.bob.address, true),
				() => h.setHardModeSkip(poolId, s.bob.address, true),
			])
				await expect(call()).to.be.revertedWith('not authorized');
			for (const call of [
				() => h.grantRole(FEE_MANAGER_ROLE, s.alice.address),
				() => h.setDefaults(1, 1, 1, true, 0, 1),
				() => h.setDefaultOutOfGasDepth(1),
				() => h.setFeeForTickSpacing(10, 1),
				() => h.setMevxRouter(s.alice.address),
				() => h.setMevxExecutor(s.alice.address),
				() => h.setProfitDistributor(s.alice.address),
			])
				await expect(call()).to.be.revertedWith(MISSING_ROLE);
		});

		it('a pool fee manager sets the fees of its pool only, not pool-admin settings', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			await (await s.hook.grantRole(await s.hook.poolRole(FEE_MANAGER_ROLE, a.poolId), s.alice.address)).wait();
			const h: any = s.hook.connect(s.alice);
			await (await h.setPoolFee(a.poolId, 111)).wait();
			await (await h.setDynamicFeeEnabled(a.poolId, true)).wait();
			await (await h.setDynamicFeeBounds(a.poolId, 10, 20)).wait();
			await (await h.setFeeOverride(a.poolId, s.alice.address, 1)).wait();
			expect((await s.hook.poolConfig(a.poolId)).staticFee).to.equal(111n);
			await expect(h.setPoolFee(b.poolId, 111)).to.be.revertedWith('not authorized');
			await expect(h.setLpShareBps(a.poolId, 1)).to.be.revertedWith('not authorized');
			await expect(h.setHardMode(a.poolId, true)).to.be.revertedWith('not authorized');

			await (await s.hook.revokeRole(await s.hook.poolRole(FEE_MANAGER_ROLE, a.poolId), s.alice.address)).wait();
			await expect(h.setPoolFee(a.poolId, 112)).to.be.revertedWith('not authorized');
		});

		it('a pool admin sets LP share, hard mode, gas budget and out-of-gas depth of its pool, within bounds', async () => {
			const s = await setup();
			const {poolId} = await createPool(s);
			await (await s.hook.grantRole(await s.hook.poolRole(POOL_ADMIN_ROLE, poolId), s.bob.address)).wait();
			const h: any = s.hook.connect(s.bob);
			await expect(h.setLpShareBps(poolId, 2500)).to.emit(s.hook, 'PoolLpShareSet').withArgs(poolId, 2500);
			await expect(h.setHardMode(poolId, true)).to.emit(s.hook, 'PoolHardModeSet').withArgs(poolId, true);
			await expect(h.setCallGasBudget(poolId, 2_000_000)).to.emit(s.hook, 'PoolCallGasBudgetSet').withArgs(poolId, 2_000_000);
			await expect(h.setOutOfGasDepth(poolId, 12)).to.emit(s.hook, 'PoolOutOfGasDepthSet').withArgs(poolId, 12);
			await expect(h.setBackrunSkip(poolId, s.carol.address, true)).to.be.revertedWith('not authorized'); // separate role
			const c = await s.hook.poolConfig(poolId);
			expect([c.lpShareBps, c.hardMode, c.callGasBudget, c.outOfGasDepth]).to.deep.equal([2500n, true, 2_000_000n, 12n]);
			expect(await s.hook.getHardMode(poolId)).to.equal(true);
			await expect(h.setLpShareBps(poolId, 10_001)).to.be.revertedWith('lp share too high');
			await expect(h.setCallGasBudget(poolId, 5_000_001)).to.be.revertedWith('callGasBudget too high');
			await expect(h.setOutOfGasDepth(poolId, 33)).to.be.revertedWith('depth too high');
			await expect(h.setPoolFee(poolId, 1)).to.be.revertedWith('not authorized');
		});

		it('a backrun skip manager sets the backrun skip list of its pool only; the admin can too', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			await (await s.hook.grantRole(await s.hook.poolRole(BACKRUN_SKIP_ROLE, a.poolId), s.dave.address)).wait();
			const h: any = s.hook.connect(s.dave);
			await expect(h.setBackrunSkip(a.poolId, s.carol.address, true)).to.emit(s.hook, 'BackrunSkipSet').withArgs(a.poolId, s.carol.address, true);
			expect(await s.hook.backrunSkipped(a.poolId, s.carol.address)).to.equal(true);
			await expect(h.setHardModeSkip(a.poolId, s.carol.address, true)).to.be.revertedWith('not authorized'); // separate role
			await expect(h.setBackrunSkip(b.poolId, s.carol.address, true)).to.be.revertedWith('not authorized');
			await expect(h.setPoolFee(a.poolId, 1)).to.be.revertedWith('not authorized');
			await expect(h.setLpShareBps(a.poolId, 1)).to.be.revertedWith('not authorized');
			await (await s.hook.setBackrunSkip(b.poolId, s.carol.address, true)).wait(); // admin
			await (await s.hook.grantRole(BACKRUN_SKIP_ROLE, s.alice.address)).wait(); // all pools
			await (await (s.hook.connect(s.alice) as any).setBackrunSkip(b.poolId, s.carol.address, false)).wait();
			expect(await s.hook.backrunSkipped(b.poolId, s.carol.address)).to.equal(false);
		});

		it('a hard mode skip manager sets the hard mode skip list of its pool only; the admin can too', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			await (await s.hook.grantRole(await s.hook.poolRole(HARD_MODE_SKIP_ROLE, a.poolId), s.dave.address)).wait();
			const h: any = s.hook.connect(s.dave);
			await expect(h.setHardModeSkip(a.poolId, s.carol.address, true)).to.emit(s.hook, 'HardModeSkipSet').withArgs(a.poolId, s.carol.address, true);
			expect(await s.hook.hardModeSkipped(a.poolId, s.carol.address)).to.equal(true);
			await expect(h.setBackrunSkip(a.poolId, s.carol.address, true)).to.be.revertedWith('not authorized'); // separate role
			await expect(h.setHardModeSkip(b.poolId, s.carol.address, true)).to.be.revertedWith('not authorized');
			await expect(h.setHardMode(a.poolId, false)).to.be.revertedWith('not authorized');
			await (await s.hook.setHardModeSkip(b.poolId, s.carol.address, true)).wait(); // admin
			await (await s.hook.grantRole(HARD_MODE_SKIP_ROLE, s.alice.address)).wait(); // all pools
			await (await (s.hook.connect(s.alice) as any).setHardModeSkip(b.poolId, s.carol.address, false)).wait();
			expect(await s.hook.hardModeSkipped(b.poolId, s.carol.address)).to.equal(false);
		});

		it('the role itself (not per pool) covers every pool', async () => {
			const s = await setup();
			const a = await createPool(s, 10);
			const b = await createPool(s, 60);
			await (await s.hook.grantRole(FEE_MANAGER_ROLE, s.carol.address)).wait();
			const h: any = s.hook.connect(s.carol);
			await (await h.setPoolFee(a.poolId, 1)).wait();
			await (await h.setPoolFee(b.poolId, 2)).wait();
			expect(await s.hook.hasPoolRole(FEE_MANAGER_ROLE, b.poolId, s.carol.address)).to.equal(true);
			expect(await s.hook.hasPoolRole(POOL_ADMIN_ROLE, b.poolId, s.carol.address)).to.equal(false);
		});

		it('the admin holds every pool role; admin transfer is two-step', async () => {
			const s = await setup();
			const {poolId} = await createPool(s);
			await (await s.hook.setPoolFee(poolId, 5)).wait();
			await (await s.hook.setHardMode(poolId, true)).wait();
			await (await s.hook.beginDefaultAdminTransfer(s.dave.address)).wait();
			expect(await s.hook.owner()).to.equal(s.deployer.address);
			await (await (s.hook.connect(s.dave) as any).acceptDefaultAdminTransfer()).wait();
			expect(await s.hook.owner()).to.equal(s.dave.address);
			await expect(s.hook.setPoolFee(poolId, 6)).to.be.revertedWith('not authorized');
		});

		it('the admin replaces the router, the executor and the distributor, never with the zero address', async () => {
			const s = await setup();
			const ZERO = '0x0000000000000000000000000000000000000000';
			await expect(s.hook.setMevxRouter(s.alice.address)).to.emit(s.hook, 'MevxRouterSet').withArgs(s.mevxRouter.target, s.alice.address);
			await expect(s.hook.setMevxExecutor(s.alice.address)).to.emit(s.hook, 'MevxExecutorSet').withArgs(s.executor.target, s.alice.address);
			await expect(s.hook.setProfitDistributor(s.alice.address))
				.to.emit(s.hook, 'ProfitDistributorSet')
				.withArgs(s.distributor.target, s.alice.address);
			await expect(s.hook.setMevxRouter(ZERO)).to.be.revertedWith('mevxRouter is zero address');
			await expect(s.hook.setMevxExecutor(ZERO)).to.be.revertedWith('mevxExecutor is zero address');
			await expect(s.hook.setProfitDistributor(ZERO)).to.be.revertedWith('profitDistributor is zero address');
		});

		it('defaults set by the admin apply to pools initialized afterwards', async () => {
			const s = await setup();
			const before = await createPool(s, 10);
			await expect(s.hook.setDefaults(4000, 1000, 1_500_000, true, 100, 9000)).to.emit(s.hook, 'DefaultsSet');
			await (await s.hook.setDefaultOutOfGasDepth(3)).wait();
			const after = await createPool(s, 7);
			const c = await s.hook.poolConfig(after.poolId);
			expect([c.staticFee, c.lpShareBps, c.callGasBudget, c.hardMode, c.dynamicFeeMin, c.dynamicFeeMax, c.outOfGasDepth]).to.deep.equal([
				4000n,
				1000n,
				1_500_000n,
				true,
				100n,
				9000n,
				3n,
			]);
			const o = await s.hook.poolConfig(before.poolId);
			expect([o.lpShareBps, o.hardMode]).to.deep.equal([5000n, false]);
			await expect(s.hook.setDefaults(4000, 1000, 5_000_001, true, 0, 1)).to.be.revertedWith('callGasBudget too high');
			await expect(s.hook.setDefaults(100_001, 1000, 1, true, 0, 1)).to.be.revertedWith('invalid fee');
			await expect(s.hook.setDefaults(1, 10_001, 1, true, 0, 1)).to.be.revertedWith('lp share too high');
			await expect(s.hook.setDefaults(1, 1, 1, true, 2, 1)).to.be.revertedWith('invalid bounds');
			await expect(s.hook.setDefaultOutOfGasDepth(33)).to.be.revertedWith('depth too high');
		});
	});
}
