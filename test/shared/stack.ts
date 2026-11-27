import {ethers} from 'hardhat';
import {setBalance} from '@nomicfoundation/hardhat-network-helpers';
import {HardhatEthersSigner} from '@nomicfoundation/hardhat-ethers/signers';
import {Contract, ContractTransactionReceipt, LogDescription} from 'ethers';

export const DYNAMIC_FEE_FLAG = 0x800000;
export const DEFAULT_FEE = 3000;
export const DEFAULT_LP_SHARE_BPS = 5000;
export const FEE_MANAGER_ROLE = ethers.id('FEE_MANAGER_ROLE');
export const POOL_ADMIN_ROLE = ethers.id('POOL_ADMIN_ROLE');
export const BACKRUN_SKIP_ROLE = ethers.id('BACKRUN_SKIP_ROLE');
export const HARD_MODE_SKIP_ROLE = ethers.id('HARD_MODE_SKIP_ROLE');
export const INITIAL_LIQUIDITY = 10n ** 24n;
export const SQRT_PRICE_1_1 = 2n ** 96n;

export const PARAMETERS_TYPE =
	'tuple(address poolManager, address owner, address mevxRouter, address mevxExecutor, address profitDistributor, uint24 defaultFee, uint16 defaultLpShareBps)';

/// MockUniV4Executor.Mode / MockPancakeExecutor.Mode
export enum ExecutorMode {
	Execute,
	NotExecuted,
	Revert,
	BurnGas,
}

/// MockMevxRouter.Mode
export enum RouterMode {
	Normal,
	Revert,
	BurnGas,
}

/// MockMevxRouter.FeeMode
export enum FeeMode {
	None,
	Fixed,
	Revert,
	BurnGas,
	EchoBaseFee,
	EchoMinPlusMax,
}

export type Parameters = {
	poolManager: string;
	owner: string;
	mevxRouter: string;
	mevxExecutor: string;
	profitDistributor: string;
	defaultFee: number;
	defaultLpShareBps: number;
};

export function encodeParameters(p: Parameters): string {
	return ethers.AbiCoder.defaultAbiCoder().encode([PARAMETERS_TYPE], [p]);
}

export type Pool = {key: any; poolId: string; tickSpacing: number};

/// What differs between the Uniswap V4 and the PancakeSwap Infinity CL test stacks
export interface Dex {
	name: string;
	hookName: string;
	/// pool type the hook registers its pools with in the router (Constants.sol)
	poolType: number;
	/// test stack: pool manager (+ Vault), test router, mock executor
	deployDex(deployer: HardhatEthersSigner): Promise<{manager: Contract; vault?: Contract; testRouter: Contract; executor: Contract}>;
	/// salt for the factory (Uniswap V4 hooks carry their permissions in the address)
	salt(factory: string, creationCode: string): string;
	poolKey(stack: Stack, currency0: string, currency1: string, fee: number, tickSpacing: number): any;
	poolKeyType: string;
	/// data the hook hands to initializePoolExternally
	routerData(stack: Stack, key: any): string;
}

export type Stack = Awaited<ReturnType<typeof deployStack>>;

export async function deployStack(dex: Dex) {
	const [deployer, alice, bob, carol, dave] = await ethers.getSigners();
	const {manager, vault, testRouter, executor} = await dex.deployDex(deployer);
	const mevxRouter: any = await (await ethers.getContractFactory('MockMevxRouter', deployer)).deploy();
	const distributor: any = await (await ethers.getContractFactory('MockProfitDistributor', deployer)).deploy();
	const factory: any = await (await ethers.getContractFactory('SingletonHookFactory', deployer)).deploy(deployer.address);

	const tokens: any[] = [];
	for (const symbol of ['TKA', 'TKB', 'TKC']) tokens.push(await (await ethers.getContractFactory('TestERC20', deployer)).deploy(symbol));
	tokens.sort((a, b) => (BigInt(a.target as string) < BigInt(b.target as string) ? -1 : 1));
	const [token0, token1, other] = tokens;

	const creationCode = (await ethers.getContractFactory(dex.hookName)).bytecode;
	const params: Parameters = {
		poolManager: await manager.getAddress(),
		owner: deployer.address,
		mevxRouter: await mevxRouter.getAddress(),
		mevxExecutor: await executor.getAddress(),
		profitDistributor: await distributor.getAddress(),
		defaultFee: DEFAULT_FEE,
		defaultLpShareBps: DEFAULT_LP_SHARE_BPS,
	};
	const salt = dex.salt(await factory.getAddress(), creationCode);
	const hookAddress: string = await factory.computeAddress(salt, ethers.keccak256(creationCode));
	await (await factory.deploy(salt, creationCode, encodeParameters(params))).wait();
	const hook: any = await ethers.getContractAt(dex.hookName, hookAddress, deployer);

	const users = [deployer, alice, bob, carol, dave];
	for (const t of tokens) {
		for (const u of users) {
			await (await t.mint(u.address, 10n ** 30n)).wait();
			await (await (t.connect(u) as any).approve(await testRouter.getAddress(), ethers.MaxUint256)).wait();
		}
		await (await t.mint(await executor.getAddress(), 10n ** 30n)).wait();
	}
	await setBalance(await executor.getAddress(), 10n ** 24n);
	for (const u of users) await setBalance(u.address, 10n ** 30n);

	return {
		dex,
		deployer,
		alice,
		bob,
		carol,
		dave,
		manager,
		vault,
		testRouter,
		executor,
		mevxRouter,
		distributor,
		factory,
		hook,
		token0,
		token1,
		other,
		creationCode,
		salt,
		params,
	};
}

export function poolIdOf(dex: Dex, key: any): string {
	return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([dex.poolKeyType], [key]));
}

/// pool on the hook at price 1 with liquidity over a wide range; `native` puts the native currency in as currency0
export async function createPool(s: Stack, tickSpacing = 10, opts: {native?: boolean; fee?: number; liquidity?: bigint} = {}): Promise<Pool> {
	const c0 = opts.native ? ethers.ZeroAddress : await s.token0.getAddress();
	const c1 = await s.token1.getAddress();
	const key = s.dex.poolKey(s, c0, c1, opts.fee ?? DYNAMIC_FEE_FLAG, tickSpacing);
	await (await s.manager.initialize(key, SQRT_PRICE_1_1)).wait();
	const range = Math.floor(60_000 / tickSpacing) * tickSpacing;
	const liquidity = opts.liquidity ?? INITIAL_LIQUIDITY;
	await (await s.testRouter.addLiquidity(key, -range, range, liquidity, {value: opts.native ? liquidity : 0n})).wait();
	return {key, poolId: poolIdOf(s.dex, key), tickSpacing};
}

export const ONE = 10n ** 18n;

/// exact-input user swap through the test router
export async function swap(
	s: Stack,
	pool: Pool,
	zeroForOne: boolean,
	opts: {amount?: bigint; from?: HardhatEthersSigner; gasLimit?: number} = {}
): Promise<ContractTransactionReceipt> {
	const amount = opts.amount ?? ONE;
	const native = pool.key.currency0 === ethers.ZeroAddress && zeroForOne;
	const router: any = s.testRouter.connect(opts.from ?? s.deployer);
	const tx = await router.swap(pool.key, zeroForOne, amount, {value: native ? amount : 0n, gasLimit: opts.gasLimit ?? 15_000_000});
	return (await tx.wait())!;
}

/// arms the mock router with an arbitrage for `pool` after a user swap in `userZeroForOne`: the executor swaps
/// `amountIn` back on the pool and pays `profit` of `profitToken` to the hook
export async function armArbitrage(
	s: Stack,
	pool: Pool,
	userZeroForOne: boolean,
	opts: {profit?: bigint; profitToken?: string; amountIn?: bigint; mode?: ExecutorMode} = {}
) {
	const profitToken = opts.profitToken ?? pool.key.currency0;
	const route = ethers.AbiCoder.defaultAbiCoder().encode(
		['uint8', s.dex.poolKeyType, 'bool', 'uint256'],
		[opts.mode ?? ExecutorMode.Execute, pool.key, !userZeroForOne, opts.profit ?? 10n ** 15n]
	);
	await (await s.mevxRouter.setArbitrage(true, '0x1234567890abcdef1234567890abcdef', profitToken, opts.amountIn ?? ONE / 2n, route)).wait();
}

export function events(contract: any, receipt: ContractTransactionReceipt, name: string): LogDescription[] {
	const address = (contract.target as string).toLowerCase();
	return receipt.logs
		.filter((l) => l.address.toLowerCase() === address)
		.map((l) => {
			try {
				return contract.interface.parseLog(l);
			} catch {
				return null;
			}
		})
		.filter((p: LogDescription | null): p is LogDescription => p !== null && p.name === name);
}

export async function balanceOf(token: string, account: string): Promise<bigint> {
	if (token === ethers.ZeroAddress) return ethers.provider.getBalance(account);
	return (await ethers.getContractAt('TestERC20', token)).balanceOf(account);
}

export const revertData = (message: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [message]).slice(2);

const fixtures = new Map<string, () => Promise<Stack>>();

/// the dex's stack through loadFixture (deployed once, restored from a snapshot afterwards)
export function fixtureFor(dex: Dex): () => Promise<Stack> {
	if (!fixtures.has(dex.name)) {
		const f = () => deployStack(dex);
		Object.defineProperty(f, 'name', {value: `stack_${dex.poolType}`});
		fixtures.set(dex.name, f);
	}
	return fixtures.get(dex.name)!;
}
