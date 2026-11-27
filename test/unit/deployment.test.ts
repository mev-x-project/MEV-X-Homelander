import {ethers, network} from 'hardhat';
import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES, PANCAKE_BITMAP, UNI_V4_FLAG_MASK, UNI_V4_HOOK_FLAGS, mineUniV4Salt, pancakeInfinity, uniV4} from '../shared/dexes';
import {DEFAULT_FEE, DEFAULT_LP_SHARE_BPS, DYNAMIC_FEE_FLAG, RouterMode, createPool, encodeParameters, fixtureFor} from '../shared/stack';

for (const dex of DEXES) {
	describe(`${dex.hookName}: deployment and pools`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		it('takes its constructor arguments from the factory, which clears them afterwards', async () => {
			const s = await setup();
			expect(await s.hook.poolManager()).to.equal(s.params.poolManager);
			expect(await s.hook.owner()).to.equal(s.deployer.address);
			expect(await s.hook.mevxRouter()).to.equal(s.params.mevxRouter);
			expect(await s.hook.mevxExecutor()).to.equal(s.params.mevxExecutor);
			expect(await s.hook.profitDistributor()).to.equal(s.params.profitDistributor);
			expect(await s.hook.defaultFee()).to.equal(DEFAULT_FEE);
			expect(await s.hook.defaultLpShareBps()).to.equal(DEFAULT_LP_SHARE_BPS);
			expect(await s.hook.defaultCallGasBudget()).to.equal(5_000_000n);
			expect(await s.hook.defaultOutOfGasDepth()).to.equal(8n);
			expect(await s.hook.defaultHardMode()).to.equal(false);
			for (const [ts, fee] of [[1, 100], [10, 500], [50, 2500], [60, 3000], [200, 10000]])
				expect(await s.hook.feeByTickSpacing(ts)).to.equal(BigInt(fee));
			expect(await s.factory.parameters()).to.equal('0x');
		});

		it('the address depends on the factory, salt and creation code only, not on the parameters', async () => {
			const s = await setup();
			const factory: any = await (await ethers.getContractFactory('SingletonHookFactory', s.deployer)).deploy(s.deployer.address);
			const salt = dex.salt(await factory.getAddress(), s.creationCode);
			const address = await factory.computeAddress(salt, ethers.keccak256(s.creationCode));
			const other = encodeParameters({...s.params, owner: s.alice.address, defaultFee: 100, defaultLpShareBps: 0});
			const snapshot = await network.provider.send('evm_snapshot', []);
			await (await factory.deploy(salt, s.creationCode, encodeParameters(s.params))).wait();
			expect(await (await ethers.getContractAt(dex.hookName, address)).owner()).to.equal(s.deployer.address);
			await network.provider.send('evm_revert', [snapshot]);
			await expect(factory.deploy(salt, s.creationCode, other)).to.emit(factory, 'HookDeployed');
			const hook = await ethers.getContractAt(dex.hookName, address);
			expect(await hook.owner()).to.equal(s.alice.address);
			expect(await hook.defaultFee()).to.equal(100n);
		});

		it('rejects zero addresses and out-of-range defaults', async () => {
			const s = await setup();
			const factory: any = await (await ethers.getContractFactory('SingletonHookFactory', s.deployer)).deploy(s.deployer.address);
			const salt = dex.salt(await factory.getAddress(), s.creationCode);
			for (const bad of [
				{mevxRouter: ethers.ZeroAddress},
				{mevxExecutor: ethers.ZeroAddress},
				{profitDistributor: ethers.ZeroAddress},
				{owner: ethers.ZeroAddress},
				{defaultFee: 100_001}, // above the 10% cap
				{defaultLpShareBps: 10_001},
			])
				await expect(factory.deploy(salt, s.creationCode, encodeParameters({...s.params, ...bad})), JSON.stringify(bad)).to.be.revertedWith('deploy failed');
		});

		it('factory: only the owner deploys, a salt is used once, ownership cannot be renounced', async () => {
			const s = await setup();
			await expect((s.factory.connect(s.alice) as any).deploy(s.salt, s.creationCode, encodeParameters(s.params))).to.be.revertedWith(
				'Ownable: caller is not the owner'
			);
			await expect(s.factory.deploy(s.salt, s.creationCode, encodeParameters(s.params))).to.be.revertedWith('deploy failed');
			await expect(s.factory.renounceOwnership()).to.be.revertedWith('renounce disabled');
			await (await s.factory.transferOwnership(s.alice.address)).wait();
			expect(await s.factory.owner()).to.equal(s.deployer.address); // two-step
			await (await (s.factory.connect(s.alice) as any).acceptOwnership()).wait();
			expect(await s.factory.owner()).to.equal(s.alice.address);
		});

		it('initialize: pool config from the tick spacing (or the default), pool key stored, pool registered in the router', async () => {
			const s = await setup();
			const pool = await createPool(s, 60);
			const c = await s.hook.poolConfig(pool.poolId);
			expect(c.initialized).to.equal(true);
			expect(c.staticFee).to.equal(3000n);
			expect(c.dynamicFeeEnabled).to.equal(false);
			expect(c.lpShareBps).to.equal(BigInt(DEFAULT_LP_SHARE_BPS));
			expect(c.hardMode).to.equal(false);
			expect(c.callGasBudget).to.equal(5_000_000n);
			expect(c.outOfGasDepth).to.equal(8n);
			expect((await s.hook.poolKeys(pool.poolId)).hooks).to.equal(s.hook.target);

			expect(await s.mevxRouter.initCalls()).to.equal(1n);
			expect(await s.mevxRouter.lastInitPoolId()).to.equal(pool.poolId);
			expect(await s.mevxRouter.lastInitPoolType()).to.equal(BigInt(dex.poolType));
			expect(await s.mevxRouter.lastInitData()).to.equal(dex.routerData(s, pool.key).toLowerCase());

			const other = await createPool(s, 45);
			expect((await s.hook.poolConfig(other.poolId)).staticFee).to.equal(BigInt(DEFAULT_FEE));
		});

		it('initialize: tick-spacing fee changes apply to pools initialized afterwards', async () => {
			const s = await setup();
			const before = await createPool(s, 10);
			await expect(s.hook.setFeeForTickSpacing(10, 777)).to.emit(s.hook, 'FeeForTickSpacingSet').withArgs(10, 500, 777);
			expect((await s.hook.poolConfig(before.poolId)).staticFee).to.equal(500n);
			const after = await createPool(s, 10, {liquidity: 10n ** 20n, native: true});
			expect((await s.hook.poolConfig(after.poolId)).staticFee).to.equal(777n);
		});

		it('initialize: a router that reverts or burns its gas does not block the pool', async () => {
			const s = await setup();
			await (await s.mevxRouter.setModes(RouterMode.Revert, RouterMode.Normal, RouterMode.Normal)).wait();
			const a = await createPool(s, 10);
			await (await s.mevxRouter.setModes(RouterMode.BurnGas, RouterMode.Normal, RouterMode.Normal)).wait();
			const b = await createPool(s, 60);
			expect((await s.hook.poolConfig(a.poolId)).initialized).to.equal(true);
			expect((await s.hook.poolConfig(b.poolId)).initialized).to.equal(true);
			expect(await s.mevxRouter.initCalls()).to.equal(0n);
		});

		it('rejects a static-fee pool', async () => {
			const s = await setup();
			const key = dex.poolKey(s, await s.token0.getAddress(), await s.token1.getAddress(), 3000, 10);
			await expect(s.manager.initialize(key, 2n ** 96n)).to.be.reverted;
		});

		it('hook entry points: only the pool manager calls the callbacks, only the hook itself runs the arbitrage and donates', async () => {
			const s = await setup();
			const pool = await createPool(s, 10);
			await expect(s.hook.runArbitrage(pool.poolId, true, 1, -1, s.deployer.address)).to.be.revertedWith('self only');
			await expect(s.hook.donateAndSettle(pool.key, 1, 0)).to.be.revertedWith('self only');
			await expect(s.hook.afterInitialize(s.deployer.address, pool.key, 2n ** 96n, 0)).to.be.reverted;
		});
	});
}

describe(`${uniV4.hookName}: address`, () => {
	it('is deployed at an address carrying exactly its four permission bits; any other address fails', async () => {
		const s = await loadFixture(fixtureFor(uniV4));
		expect(BigInt(s.hook.target as string) & UNI_V4_FLAG_MASK).to.equal(UNI_V4_HOOK_FLAGS);
		const initCodeHash = ethers.keccak256(s.creationCode);
		let salt = ethers.ZeroHash;
		for (let i = 1_000_000; ; i++) {
			salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
			if ((BigInt(await s.factory.computeAddress(salt, initCodeHash)) & UNI_V4_FLAG_MASK) !== UNI_V4_HOOK_FLAGS) break;
		}
		await expect(s.factory.deploy(salt, s.creationCode, encodeParameters(s.params))).to.be.revertedWith('deploy failed');
		const good = mineUniV4Salt(await s.factory.getAddress(), s.creationCode, 1_000_000);
		await expect(s.factory.deploy(good, s.creationCode, encodeParameters(s.params))).to.emit(s.factory, 'HookDeployed');
	});
});

describe(`${pancakeInfinity.hookName}: registration`, () => {
	it('reports its callbacks bitmap and reads the vault from the pool manager', async () => {
		const s = await loadFixture(fixtureFor(pancakeInfinity));
		expect(await s.hook.getHooksRegistrationBitmap()).to.equal(PANCAKE_BITMAP);
		expect(await s.hook.vault()).to.equal(s.vault!.target);
	});

	it('pools whose parameters bitmap differs from the hook bitmap are rejected', async () => {
		const s = await loadFixture(fixtureFor(pancakeInfinity));
		const key = pancakeInfinity.poolKey(s, await s.token0.getAddress(), await s.token1.getAddress(), DYNAMIC_FEE_FLAG, 10);
		key.parameters = ethers.toBeHex((10n << 16n) | BigInt(PANCAKE_BITMAP & ~(1 << 7)), 32);
		await expect(s.manager.initialize(key, 2n ** 96n)).to.be.reverted;
	});
});
