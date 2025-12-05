import 'dotenv/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'hardhat-deploy';
import '@nomicfoundation/hardhat-ethers';
import '@nomicfoundation/hardhat-verify';
import "@nomicfoundation/hardhat-chai-matchers"
import 'hardhat-deploy-ethers';
import 'hardhat-gas-reporter';
import '@typechain/hardhat';
import 'solidity-coverage';
import 'hardhat-deploy-tenderly';
import 'hardhat-contract-sizer';
import 'hardhat-tracer'

import { addForkConfiguration } from './helper-tools/utils/network';
import { defaultNetworks } from './networks.config';
import { task } from 'hardhat/config';

const OPTIMIZER_RUNS = 1;

const config: HardhatUserConfig = {
	solidity: {
		compilers: [
			{
				version: '0.8.26',
				settings: {
					viaIR: true,
					evmVersion: 'cancun',
					optimizer: {
						enabled: true,
						runs: OPTIMIZER_RUNS,
					},
				},
			},
		],
	},
	networks: addForkConfiguration(defaultNetworks),
	gasReporter: {
		currency: 'USD',
		gasPrice: 100,
		enabled: process.env.REPORT_GAS ? true : false,
		coinmarketcap: process.env.COINMARKETCAP_API_KEY,
		maxMethodDiff: 10,
	},
	tracer: {
		tasks: ["deploy"],
	},
	typechain: {
		outDir: 'typechain',
	},
	mocha: {
		timeout: 200000000000000,
	},
	external: process.env.HARDHAT_FORK
		? {
			deployments: {
				// process.env.HARDHAT_FORK will specify the network that the fork is made from.
				// these lines allow it to fetch the deployments from the network being forked from both for node and deploy task
				hardhat: ['deployments/' + process.env.HARDHAT_FORK],
				localhost: ['deployments/' + process.env.HARDHAT_FORK],
			},
		}
		: undefined,
};
task("deployments", "List all deployed contract addresses")
	.setAction(async (_, hre) => {
		const deployments = await hre.deployments.all()
		for (const contractName in deployments) {
			console.log(`${contractName} \`${deployments[contractName].address}\``)
		}
	})

task("verify-etherscan", "Verify all deployments using etherscan-verify")
	.addOptionalParam("pattern", "Filter deployments to only those which name includes {{pattern}}")
	.addOptionalParam("contract", "The name of contract that should be verified")
	.setAction(async (taskArgs, hre) => {
		const deployments = await hre.deployments.all()
		for (const deploymentName in deployments) {
			if (taskArgs.pattern && !deploymentName.includes(taskArgs.pattern)) continue

			const metadataString = deployments[deploymentName].metadata
			if (metadataString === undefined) continue
			const metadata = JSON.parse(metadataString)
			const [path, contractName]: any = Object.entries(metadata.settings.compilationTarget)[0]
			if (contractName === "AggregationExecutorSimple") continue
			if (taskArgs.contract && contractName != taskArgs.contract) continue
			console.log('\x1b[33m%s\x1b[0m', `Verifying ${deploymentName} at address: ${deployments[deploymentName].address}`);

			try {
				await hre.run("verify:verify", {
					contract: `${path}:${contractName}`,
					address: deployments[deploymentName].address,
					constructorArguments: deployments[deploymentName].args,
					chain_id: 137,
					libs: {
					}
				});
			} catch (error) {
				console.error(error)
			} finally {
				console.log()
			}
		}
	})

export default config;
