import { node_url } from './helper-tools/utils/network';
import { env } from "process";

export const defaultNetworks = {
	hardhat: {
		initialBaseFeePerGas: 0, // to fix : https://github.com/sc-forks/solidity-coverage/issues/652, see https://github.com/sc-forks/solidity-coverage/issues/652#issuecomment-896330136
		tags: ["local"],
		chainId: 1,
		allowUnlimitedContractSize: true,
	},
	localhost: {
		url: "127.0.0.1",
		tags: ["local"]
	},
	bsc_mainnet: {
		tags: ["mainnet"],
		url: node_url("bsc_mainnet"),
		chainId: 56,
		verify: {
			etherscan: {
				apiKey: env.BSCSCAN_API_KEY,
			},
		},
	},
	monad_testnet: {
		tags: ["testnet"],
		url: node_url("monad_testnet"),
		chainId: 10143,
	},
	monad_mainnet: {
		tags: ["mainnet"],
		url: node_url("monad_mainnet"),
		chainId: 143,
	},
	eth_mainnet: {
		tags: ["mainnet"],
		url: node_url('eth'),
		chainId: 1,
		verify: {
			etherscan: {
				apiKey: env.ETHSCAN_API_KEY
			},
		},
	},
	polygon_dev: {
		tags: ["mainnet"],
		url: node_url("polygon_mainnet"),
		chainId: 137,
		verify: {
			etherscan: {
				apiKey: env.POLYGONSCAN_API_KEY,
				chainId: 137,
			},
		},
	},
	polygon_prod: {
		tags: ["mainnet"],
		url: node_url("polygon_mainnet"),
		chainId: 137,
		verify: {
			etherscan: {
				apiKey: env.POLYGONSCAN_API_KEY,
				chainId: 137,
			},
		},
	},
	base_mainnet: {
		tags: ["mainnet"],
		url: node_url("base_mainnet"),
		chainId: 8453,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 8453,
			},
		},
	},
	avax_mainnet: {
		tags: ["mainnet"],
		url: node_url("avax_mainnet"),
		chainId: 43114,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 43114,
			},
		},
	},
	sonic_mainnet: {
		tags: ['mainnet'],
		url: node_url('sonic_mainnet'),
		chainId: 146,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 146,
			},
		},
	},
	arbitrum_mainnet: {
		tags: ['mainnet'],
		url: node_url('arbitrum_mainnet'),
		chainId: 42161,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 42161,
			},
		},
	},
	linea_mainnet: {
		tags: ['mainnet'],
		url: node_url('linea_mainnet'),
		chainId: 59144,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 59144,
			},
		},
	},
	blast_mainnet: {
		tags: ['mainnet'],
		url: node_url('blast_mainnet'),
		chainId: 81457,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 81457,
			},
		},
	},
	berachain_mainnet: {
		tags: ['mainnet'],
		url: node_url('berachain_mainnet'),
		chainId: 80094,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 80094,
			},
		},
	},
	katana_mainnet: {
		tags: ['mainnet'],
		url: node_url('katana_mainnet'),
		chainId: 747474,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 747474,
			},
		},
	},
	base_plugin: {
		tags: ['mainnet'],
		url: node_url('base_mainnet'),
		chainId: 8453,
	},
	ronin_mainnet: {
		tags: ['mainnet'],
		url: node_url('ronin_mainnet'),
		chainId: 2020,
		verify: {
			etherscan: {
				apiKey: env.BASESCAN_API_KEY,
				chainId: 2020,
			},
		},
	},
};
