import 'dotenv/config';
import {HardhatUserConfig, subtask} from 'hardhat/config';
import {TASK_COMPILE_SOLIDITY_READ_FILE} from 'hardhat/builtin-tasks/task-names';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-chai-matchers';
import '@typechain/hardhat';
import 'solidity-coverage';

// PancakeSwap Infinity's Vault (compiled only for the local test stack) is written against OpenZeppelin 5, the hooks
// against OpenZeppelin 4.9: infinity-core sources read OpenZeppelin from the v5 alias
subtask(TASK_COMPILE_SOLIDITY_READ_FILE).setAction(async (args: {absolutePath: string}, _hre, runSuper) => {
	const content: string = await runSuper(args);
	if (!args.absolutePath.includes('/node_modules/infinity-core/')) return content;
	return content.replace(/"@openzeppelin\/contracts\//g, '"@openzeppelin/contracts-v5/');
});

const config: HardhatUserConfig = {
	solidity: {
		compilers: [
			{
				version: '0.8.26',
				settings: {
					viaIR: true,
					evmVersion: 'cancun',
					optimizer: {enabled: true, runs: 1},
					// as hardhat-deploy compiled the deployed hooks: sources embedded in the metadata
					metadata: {useLiteralContent: true},
				},
			},
		],
	},
	networks: {
		hardhat: {
			hardfork: 'cancun',
			allowUnlimitedContractSize: true,
		},
	},
	typechain: {outDir: 'typechain', target: 'ethers-v6'},
	mocha: {timeout: 600_000},
};

export default config;
