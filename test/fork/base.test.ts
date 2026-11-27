import {ethers, network} from 'hardhat';
import {expect} from 'chai';
import {impersonateAccount, setBalance, setCode} from '@nomicfoundation/hardhat-network-helpers';
import {HardhatEthersSigner} from '@nomicfoundation/hardhat-ethers/signers';
import {Contract, ContractTransactionReceipt} from 'ethers';
import {PANCAKE_BITMAP, mineUniV4Salt} from '../shared/dexes';
import {encodeParameters, events} from '../shared/stack';

// Base mainnet at a fixed block, against the live MEV-X stack: the hooks' code is replaced by the code compiled from
// this repository (same storage layout and immutables), a fresh WETH/USDC pool is created on each hook next to the
// WETH/USDC 0.05% Uniswap V3 pool, a route book with the cycle through both pools is set in the live router, and a
// user swap on the new pool is backrun by the live router and executor.
//   BASE_FORK_RPC=<archive RPC> yarn test:fork
const RPC = process.env.BASE_FORK_RPC;
const BLOCK = Number(process.env.BASE_FORK_BLOCK ?? 58_160_000);

const BASE = {
	weth: '0x4200000000000000000000000000000000000006',
	usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	marketPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', // Uniswap V3 WETH/USDC 0.05%
	mevxRouter: '0x59D1C6dC76EC6eAB41B48045B990530Daf50b1b3',
	routeBookFactory: '0xa422814165abb337907b6d453a600063Eb698540',
	uniV4: {poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b', hook: '0x4F0067581931d9205E848862a7042b5EBc11f0c0'},
	pancake: {
		vault: '0x238a358808379702088667322f80aC48bAd5e6c4',
		clPoolManager: '0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b',
		hook: '0x5c9717DD21055c40b498F9F38CCe91FC3AAEf2B8',
	},
};
const TICK_SPACING = 30;
const DYNAMIC_FEE_FLAG = 0x800000;
const UNI_V4_POOL_TYPE = 5;
const UNI_V3_POOL_TYPE = 1;
const PANCAKE_POOL_TYPE = 10;

const ROUTER_ABI = [
	'function owner() view returns (address)',
	'function setRouteBook(bytes32 poolId, address book, uint256[] coefficients)',
	'function routeBook(bytes32 poolId) view returns (address)',
];
const ROUTE_BOOK_FACTORY_ABI = ['function write(bytes book) returns (address)', 'function addressOf(bytes book) view returns (address)'];
const ERC20_ABI = [
	'function transfer(address,uint256) returns (bool)',
	'function approve(address,uint256) returns (bool)',
	'function balanceOf(address) view returns (uint256)',
	'function deposit() payable',
];
const V3_POOL_ABI = [
	'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
	'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
];

type Hop = {fee: number; poolType: number; zeroForOne: boolean; refreshFee: boolean; data: string};

/// Route book of the live router with one cycle: [cycleCount:1] then per cycle
/// [startToken:20][targetIndex:1][segmentLength:2] and the segment [hopCount:1] card*, card = [fee:2][info:1][data],
/// info = zeroForOne << 7 | refreshFee << 6 | poolType
function encodeBook(startToken: string, targetIndex: number, hops: Hop[]): string {
	const cards = hops.map((h) =>
		ethers.concat([ethers.toBeHex(h.fee, 2), ethers.toBeHex((h.zeroForOne ? 0x80 : 0) | (h.refreshFee ? 0x40 : 0) | h.poolType, 1), h.data])
	);
	const segment = ethers.concat([ethers.toBeHex(hops.length, 1), ...cards]);
	return ethers.concat(['0x01', startToken, ethers.toBeHex(targetIndex, 1), ethers.toBeHex(ethers.dataLength(segment), 2), segment]);
}

/// coefficient 1.0 for both directions of the cycle: 25-bit floats (exponent 32, mantissa 0), ten per slot
const COEFFICIENTS_ONE = [(32n << 19n) | ((32n << 19n) << 25n)];

/// liquidity for `amount0` of currency0 between the current price and the upper tick
function liquidityFor(amount0: bigint, sqrtPriceX96: bigint, tickUpper: number): bigint {
	const sp = Number(sqrtPriceX96) / 2 ** 96;
	const sb = Math.sqrt(1.0001 ** tickUpper);
	return BigInt(Math.floor(((Number(amount0) * sp * sb) / (sb - sp)) * 0.98));
}

async function deployTestRouter(name: string, args: any[], deployer: HardhatEthersSigner): Promise<any> {
	return (await ethers.getContractFactory(name, deployer)).deploy(...args);
}

const describeFork = RPC ? describe : describe.skip;

describeFork(`Base fork at block ${BLOCK}: live router and executor backrun a swap on the hooks built from this repository`, function () {
	let user: HardhatEthersSigner;
	let weth: Contract;
	let usdc: Contract;
	let sqrtPriceX96: bigint;
	let tick: number;

	before(async () => {
		await network.provider.request({method: 'hardhat_reset', params: [{forking: {jsonRpcUrl: RPC, blockNumber: BLOCK}}]});
		[user] = await ethers.getSigners();
		await setBalance(user.address, 10n ** 24n);
		weth = new Contract(BASE.weth, ERC20_ABI, user);
		usdc = new Contract(BASE.usdc, ERC20_ABI, user);
		await (await weth.deposit({value: 100n * 10n ** 18n})).wait();
		// USDC from the market pool's reserves
		await impersonateAccount(BASE.marketPool);
		await setBalance(BASE.marketPool, 10n ** 18n);
		await (await (usdc.connect(await ethers.getSigner(BASE.marketPool)) as any).transfer(user.address, 500_000n * 10n ** 6n)).wait();
		const slot0 = await new Contract(BASE.marketPool, V3_POOL_ABI, user).slot0();
		sqrtPriceX96 = slot0.sqrtPriceX96;
		tick = Number(slot0.tick);
	});

	after(async () => {
		await network.provider.request({method: 'hardhat_reset', params: []});
	});

	/// replaces the live hook's code with this repository's build: deploys it through a new factory with the live
	/// hook's parameters (so that the immutables match) and copies its runtime code over
	async function installHook(name: string, live: string, salt: (factory: string, code: string) => string): Promise<any> {
		const liveHook: any = await ethers.getContractAt(name, live);
		const factory: any = await (await ethers.getContractFactory('SingletonHookFactory', user)).deploy(user.address);
		const creationCode = (await ethers.getContractFactory(name)).bytecode;
		const s = salt(await factory.getAddress(), creationCode);
		const address = await factory.computeAddress(s, ethers.keccak256(creationCode));
		const params = {
			poolManager: await liveHook.poolManager(),
			owner: await liveHook.owner(),
			mevxRouter: await liveHook.mevxRouter(),
			mevxExecutor: await liveHook.mevxExecutor(),
			profitDistributor: await liveHook.profitDistributor(),
			defaultFee: Number(await liveHook.defaultFee()),
			defaultLpShareBps: Number(await liveHook.defaultLpShareBps()),
		};
		await (await factory.deploy(s, creationCode, encodeParameters(params))).wait();
		await setCode(live, await ethers.provider.getCode(address));
		return liveHook;
	}

	async function setBook(poolId: string, book: string) {
		const factory = new Contract(BASE.routeBookFactory, ROUTE_BOOK_FACTORY_ABI, user);
		const address = await factory.addressOf(book);
		if ((await ethers.provider.getCode(address)) === '0x') await (await factory.write(book)).wait();
		const router = new Contract(BASE.mevxRouter, ROUTER_ABI, user);
		const owner = await router.owner();
		await impersonateAccount(owner);
		await setBalance(owner, 10n ** 18n);
		await (await (router.connect(await ethers.getSigner(owner)) as any).setRouteBook(poolId, address, COEFFICIENTS_ONE)).wait();
		expect(await router.routeBook(poolId)).to.equal(address);
	}

	/// what every backrun must show: the hook's ProfitShared, a fee-free executor swap on our pool, the market swap
	async function expectBackrun(hook: any, manager: any, r: ContractTransactionReceipt, poolId: string, executor: string) {
		const shared = events(hook, r, 'ProfitShared');
		expect(shared.length, 'ProfitShared').to.equal(1);
		expect(shared[0].args.poolId).to.equal(poolId);
		expect(shared[0].args.profitToken).to.equal(BASE.weth);
		const donated = shared[0].args.donatedToLps as bigint;
		const sent = shared[0].args.sentToDistributor as bigint;
		const lpShare = BigInt((await hook.poolConfig(poolId)).lpShareBps);
		expect(donated).to.equal(((donated + sent) * lpShare) / 10_000n);
		expect(donated + sent).to.be.greaterThan(0n);

		const swaps = events(manager, r, 'Swap').filter((e) => e.args.id === poolId);
		expect(swaps.length).to.equal(2);
		expect(swaps[1].args.sender).to.equal(executor);
		// LP fee 0 for the executor; PancakeSwap's event fee also counts the AMM's own protocol fee
		const protocolFee = swaps[1].fragment.inputs.some((i: any) => i.name === 'protocolFee') ? BigInt(swaps[1].args.protocolFee) : 0n;
		expect(swaps[1].args.fee).to.equal(protocolFee);
		const market = new Contract(BASE.marketPool, V3_POOL_ABI, user);
		expect(events(market, r, 'Swap').length).to.equal(1);
		return {donated, sent};
	}

	/// the same swap from a caller that keeps a currency synced across it (see UniV4SyncHoldingRouter): paying before the
	/// swap, after it, and with another currency synced and overpaid. The live executor's settlements run while the sync
	/// is pending; the caller's settle() must still be credited exactly what it paid
	async function expectBackrunsUnderPendingSync(hook: any, manager: any, router: any, key: any, poolId: string, executor: string) {
		// a token outside the swap for the multi-hop case (a held currency the caller also takes would underflow its own settle)
		const other: any = await (await ethers.getContractFactory('TestERC20', user)).deploy('HOLD');
		await (await other.mint(user.address, 10n ** 24n)).wait();
		for (const t of [weth, usdc, other]) await (await t.approve(router, ethers.MaxUint256)).wait();
		for (const [payBefore, hold, extra] of [
			[true, ethers.ZeroAddress, 0n],
			[false, ethers.ZeroAddress, 0n],
			[true, other.target as string, 1234n],
			[false, other.target as string, 1234n],
		] as const) {
			const order = {keys: [key], zeroForOne: true, amountIn: 10n ** 18n, payBefore, extra, hold};
			const r = (await (await router.swap(order, {gasLimit: 6_000_000})).wait())!;
			await expectBackrun(hook, manager, r, poolId, executor);
			console.log(`      pending sync (pay ${payBefore ? 'before' : 'after'}, hold ${hold === ethers.ZeroAddress ? 'input' : 'other token'}): swap gas ${r.gasUsed}`);
		}
	}

	it('Uniswap V4 singleton hook', async () => {
		const hook = await installHook('HomelanderUniV4SingletonHook', BASE.uniV4.hook, (f, c) => mineUniV4Salt(f, c));
		const manager: any = await ethers.getContractAt('PoolManager', BASE.uniV4.poolManager, user);
		const key = {currency0: BASE.weth, currency1: BASE.usdc, fee: DYNAMIC_FEE_FLAG, tickSpacing: TICK_SPACING, hooks: BASE.uniV4.hook};
		const poolId = ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(['tuple(address,address,uint24,int24,address)'], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]])
		);
		const testRouter = await deployTestRouter('UniV4TestRouter', [BASE.uniV4.poolManager], user);
		for (const t of [weth, usdc]) await (await t.approve(testRouter, ethers.MaxUint256)).wait();

		await (await manager.initialize(key, sqrtPriceX96)).wait();
		const lower = Math.floor(tick / TICK_SPACING) * TICK_SPACING - 3000;
		const upper = Math.floor(tick / TICK_SPACING) * TICK_SPACING + 3000;
		await (await testRouter.addLiquidity(key, lower, upper, liquidityFor(5n * 10n ** 18n, sqrtPriceX96, upper))).wait();
		expect((await hook.poolConfig(poolId)).initialized).to.equal(true);

		const v4Card = ethers.solidityPacked(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
		await setBook(
			poolId,
			encodeBook(BASE.weth, 0, [
				{fee: 0, poolType: UNI_V4_POOL_TYPE, zeroForOne: true, refreshFee: false, data: v4Card}, // WETH -> USDC on the hook pool
				{fee: 50, poolType: UNI_V3_POOL_TYPE, zeroForOne: false, refreshFee: true, data: BASE.marketPool}, // USDC -> WETH on the market
			])
		);

		const r = (await (await testRouter.swap(key, true, 10n ** 18n, {gasLimit: 6_000_000})).wait())!;
		const {sent} = await expectBackrun(hook, manager, r, poolId, await hook.mevxExecutor());
		console.log(`      profit ${ethers.formatEther(sent * 2n)} WETH, swap gas ${r.gasUsed}`);
		const holding = await deployTestRouter('UniV4SyncHoldingRouter', [BASE.uniV4.poolManager], user);
		await expectBackrunsUnderPendingSync(hook, manager, holding, key, poolId, await hook.mevxExecutor());
	});

	it('PancakeSwap Infinity CL singleton hook', async () => {
		const hook = await installHook('HomelanderPancakeInfinitySingletonHook', BASE.pancake.hook, () => ethers.id('homelander.pancake.singleton.hook'));
		const manager: any = await ethers.getContractAt('CLPoolManager', BASE.pancake.clPoolManager, user);
		expect(await hook.vault()).to.equal(BASE.pancake.vault);
		const parameters = ethers.toBeHex((BigInt(TICK_SPACING) << 16n) | BigInt(PANCAKE_BITMAP), 32);
		const key = {currency0: BASE.weth, currency1: BASE.usdc, hooks: BASE.pancake.hook, poolManager: BASE.pancake.clPoolManager, fee: DYNAMIC_FEE_FLAG, parameters};
		const poolId = ethers.keccak256(
			ethers.AbiCoder.defaultAbiCoder().encode(
				['tuple(address,address,address,address,uint24,bytes32)'],
				[[key.currency0, key.currency1, key.hooks, key.poolManager, key.fee, key.parameters]]
			)
		);
		const testRouter = await deployTestRouter('PancakeTestRouter', [BASE.pancake.vault, BASE.pancake.clPoolManager], user);
		for (const t of [weth, usdc]) await (await t.approve(testRouter, ethers.MaxUint256)).wait();

		await (await manager.initialize(key, sqrtPriceX96)).wait();
		const lower = Math.floor(tick / TICK_SPACING) * TICK_SPACING - 3000;
		const upper = Math.floor(tick / TICK_SPACING) * TICK_SPACING + 3000;
		await (await testRouter.addLiquidity(key, lower, upper, liquidityFor(5n * 10n ** 18n, sqrtPriceX96, upper))).wait();
		expect((await hook.poolConfig(poolId)).initialized).to.equal(true);

		const card = ethers.solidityPacked(
			['address', 'address', 'address', 'uint24', 'int24', 'address', 'uint16'],
			[key.currency0, key.currency1, key.poolManager, key.fee, TICK_SPACING, key.hooks, PANCAKE_BITMAP]
		);
		await setBook(
			poolId,
			encodeBook(BASE.weth, 0, [
				{fee: 0, poolType: PANCAKE_POOL_TYPE, zeroForOne: true, refreshFee: false, data: card},
				{fee: 50, poolType: UNI_V3_POOL_TYPE, zeroForOne: false, refreshFee: true, data: BASE.marketPool},
			])
		);

		const r = (await (await testRouter.swap(key, true, 10n ** 18n, {gasLimit: 6_000_000})).wait())!;
		const {sent} = await expectBackrun(hook, manager, r, poolId, await hook.mevxExecutor());
		console.log(`      profit ${ethers.formatEther(sent * 2n)} WETH, swap gas ${r.gasUsed}`);
		const holding = await deployTestRouter('PancakeSyncHoldingRouter', [BASE.pancake.vault, BASE.pancake.clPoolManager], user);
		await expectBackrunsUnderPendingSync(hook, manager, holding, key, poolId, await hook.mevxExecutor());
	});
});
