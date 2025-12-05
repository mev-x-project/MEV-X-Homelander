import 'dotenv/config';
import { HDAccountsUserConfig, HttpNetworkUserConfig, NetworksUserConfig } from 'hardhat/types';
import { env } from 'process';

export function node_url(networkName: string): string {
	if (networkName) {
		const uri = process.env['ETH_NODE_URI_' + networkName.toUpperCase()];
		if (uri && uri !== '') {
			return uri;
		}
	}
}

export function accounts() {
	let unnamedSigners: string[] = []
	if (process.env.ACCOUNTS) {
		unnamedSigners = unnamedSigners.concat(process.env.ACCOUNTS.split(" "))
	}
	unnamedSigners = [...new Set(unnamedSigners)].filter((value: string) => value != '' && value != undefined)
	return unnamedSigners
}

export function addForkConfiguration(networks: NetworksUserConfig): NetworksUserConfig {
	// While waiting for hardhat PR: https://github.com/nomiclabs/hardhat/pull/1542
	if (process.env.HARDHAT_FORK) {
		process.env['HARDHAT_DEPLOY_FORK'] = process.env.HARDHAT_FORK;
	}

	for (const networkName in networks) {
		const currentUrl = (networks[networkName] as HttpNetworkUserConfig).url
		if (currentUrl === undefined && networkName !== "hardhat" && networkName !== "localhost") {
			delete networks[networkName];
		} else {
			(networks[networkName] as HttpNetworkUserConfig).accounts = accounts();
		}
	}

	const currentNetworkName = process.env.HARDHAT_FORK;
	let forkURL: string | undefined = currentNetworkName && node_url(currentNetworkName);
	let forkChainID = networks.hardhat.chainId
	let hardhatAccounts: HDAccountsUserConfig | undefined;
	if (currentNetworkName && currentNetworkName !== 'hardhat') {
		const currentNetwork = networks[currentNetworkName] as HttpNetworkUserConfig;
		forkChainID = networks[currentNetworkName].chainId && networks[currentNetworkName].chainId
		if (currentNetwork) {
			forkURL = currentNetwork.url;
			if (
				currentNetwork.accounts &&
				typeof currentNetwork.accounts === 'object' &&
				'mnemonic' in currentNetwork.accounts
			) {
				hardhatAccounts = currentNetwork.accounts;
				if (currentNetworkName === 'linea') {
					console.log(hardhatAccounts)
				}
			}
		}
	}
	const newNetworks = {
		...networks,
		hardhat: {
			...networks.hardhat,
			chainId: forkChainID,
			...{
				accounts: hardhatAccounts,
				forking: forkURL
					? {
						url: forkURL,
						blockNumber: process.env.HARDHAT_FORK_NUMBER
							? parseInt(process.env.HARDHAT_FORK_NUMBER)
							: undefined,
					}
					: undefined,
				mining: process.env.MINING_INTERVAL
					? {
						auto: false,
						interval: process.env.MINING_INTERVAL.split(',').map((v) => parseInt(v)) as [
							number,
							number
						],
					}
					: undefined,
			},
		},
	};
	return newNetworks;
}
