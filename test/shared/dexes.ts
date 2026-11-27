import {ethers} from 'hardhat';
import {Dex, Stack} from './stack';

export const UNI_V4_HOOK_FLAGS = (1n << 13n) | (1n << 12n) | (1n << 7n) | (1n << 6n); // before/afterInitialize, before/afterSwap
export const UNI_V4_FLAG_MASK = (1n << 14n) - 1n;
/// beforeInitialize, afterInitialize, beforeSwap, afterSwap (CLHooks offsets 0, 1, 6, 7)
export const PANCAKE_BITMAP = (1 << 0) | (1 << 1) | (1 << 6) | (1 << 7);

/// first salt from `start` whose CREATE2 address carries exactly the hook's permission bits
export function mineUniV4Salt(factory: string, creationCode: string, start = 0): string {
	const initCodeHash = ethers.keccak256(creationCode);
	for (let i = start; ; i++) {
		const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
		if ((BigInt(ethers.getCreate2Address(factory, salt, initCodeHash)) & UNI_V4_FLAG_MASK) === UNI_V4_HOOK_FLAGS) return salt;
	}
}

export const uniV4: Dex = {
	name: 'Uniswap V4',
	hookName: 'HomelanderUniV4SingletonHook',
	poolType: 5,
	async deployDex(deployer) {
		const manager: any = await (await ethers.getContractFactory('PoolManager', deployer)).deploy(deployer.address);
		const testRouter: any = await (await ethers.getContractFactory('UniV4TestRouter', deployer)).deploy(manager);
		const executor: any = await (await ethers.getContractFactory('MockUniV4Executor', deployer)).deploy(manager);
		return {manager, testRouter, executor};
	},
	salt: (factory, creationCode) => mineUniV4Salt(factory, creationCode),
	poolKey: (s: Stack, currency0, currency1, fee, tickSpacing) => ({currency0, currency1, fee, tickSpacing, hooks: s.hook?.target}),
	poolKeyType: 'tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
	routerData: (_s, k) =>
		ethers.solidityPacked(['address', 'address', 'uint24', 'int24', 'address'], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]),
};

export const pancakeInfinity: Dex = {
	name: 'PancakeSwap Infinity CL',
	hookName: 'HomelanderPancakeInfinitySingletonHook',
	poolType: 10,
	async deployDex(deployer) {
		const vault: any = await (await ethers.getContractFactory('infinity-core/src/Vault.sol:Vault', deployer)).deploy();
		const manager: any = await (await ethers.getContractFactory('CLPoolManager', deployer)).deploy(vault);
		await (await vault.registerApp(manager)).wait();
		const testRouter: any = await (await ethers.getContractFactory('PancakeTestRouter', deployer)).deploy(vault, manager);
		const executor: any = await (await ethers.getContractFactory('MockPancakeExecutor', deployer)).deploy(vault, manager);
		return {manager, vault, testRouter, executor};
	},
	salt: () => ethers.id('homelander.pancake.singleton.hook'),
	poolKey: (s: Stack, currency0, currency1, fee, tickSpacing) => ({
		currency0,
		currency1,
		hooks: s.hook.target,
		poolManager: s.manager.target,
		fee,
		parameters: ethers.toBeHex((BigInt(tickSpacing) << 16n) | BigInt(PANCAKE_BITMAP), 32),
	}),
	poolKeyType: 'tuple(address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)',
	routerData: (_s, k) =>
		ethers.solidityPacked(
			['address', 'address', 'address', 'uint24', 'int24', 'address', 'uint16'],
			[k.currency0, k.currency1, k.poolManager, k.fee, Number(BigInt(k.parameters) >> 16n), k.hooks, Number(BigInt(k.parameters) & 0xffffn)]
		),
};

export const DEXES = [uniV4, pancakeInfinity];
