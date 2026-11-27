# MEV-X Homelander

MEV-X Homelander is an on-chain, atomic MEV internalization module for DEXs that executes backrun opportunities within the originating transaction and retains the resulting value inside the protocol's economic domain. It integrates through the AMM's post-swap hook, which serves as the trigger for entering Homelander's internal execution path. The contracts in this repository cover only the hook-facing component and related interfaces used during audit. For a broader overview of the protocol, motivation, and design rationale, see the [MEV-X Homelander GitBook](https://mx0-1.gitbook.io/mev-x-homelander/the-scale-of-mev-leakage).

Homelander supports integration with **Algebra Integral**, **Uniswap V4** and **PancakeSwap Infinity** pools, hooking into each AMM's native post-swap callback mechanism.

## Audits

Homelander has been independently audited for both supported AMM integrations:

- **Uniswap V4 integration** — audited by MixBytes:
  [https://github.com/mixbytes/audits_public/tree/master/MEV-X/Homelander](https://github.com/mixbytes/audits_public/tree/master/MEV-X/Homelander)

- **Algebra Integral integration** — audited by BailSec:
  [Bailsec - MEV-X - Plugin - Final Report.pdf](https://github.com/bailsec/BailSec/blob/main/Bailsec%20-%20MEV-X%20-%20Plugin%20-%20Final%20Report.pdf)

## System Components

The full Homelander execution stack consists of four on-chain components:

- **Plugin:** Implements the post-swap hook (`afterSwap`) and serves as the entrypoint for MEV internalization. The plugin inspects the finalized pool state and interacts with the MEV-X execution stack. Per-pool plugins are provided for Algebra Integral and Uniswap V4 pools, and singleton hooks for Uniswap V4 and PancakeSwap Infinity CL pools, all sharing the same internal execution path. This repository contains only this component and the interfaces required for external integration.

- **MEV-X Router:** Stores precomputed arbitrage routes for supported pools and performs lightweight validation of whether a profitable opportunity exists. When triggered via `afterSwap`, it returns execution data for the relevant route.

- **MEV-X Executor:** Executes the internal arbitrage using the route data provided by the MEV-X Router. All swaps are performed atomically within the originating transaction.

- **Profit Distributor:** Handles allocation of extracted value according to the configured distribution model.

## Singleton Hooks

`contracts/singleton_hook/` holds two singleton hooks with the same logic:

- `HomelanderUniV4SingletonHook` for Uniswap V4;
- `HomelanderPancakeInfinitySingletonHook` for PancakeSwap Infinity CL.

Each is a single, non-upgradeable hook that serves every pool created with it. Both are deployed by `SingletonHookFactory` at the same address on every chain:

| Contract | Address | Chains |
| --- | --- | --- |
| `SingletonHookFactory` | `0xB972d7effAe885202C0DE695108fd659fe0C7f40` | Ethereum, Base, BNB Chain, Robinhood |
| `HomelanderUniV4SingletonHook` | `0x4F0067581931d9205E848862a7042b5EBc11f0c0` | Ethereum, Base, BNB Chain, Robinhood |
| `HomelanderPancakeInfinitySingletonHook` | `0x5c9717DD21055c40b498F9F38CCe91FC3AAEf2B8` | Base, BNB Chain, Robinhood |

Both hooks will be redeployed from the audited commit; the addresses above are the current deployments.

Hook permissions: `beforeInitialize`, `afterInitialize`, `beforeSwap`, `afterSwap`. There are no return-delta permissions, so the hook never takes tokens from a swap or adds tokens to it.

- **Pools:** dynamic-fee pools only (`fee = 0x800000`). On `afterInitialize` the hook stores the pool's config and registers the pool with the MEV-X Router. The config holds the static fee (by tick spacing, or the default), the call gas budget, hard mode and the LP share.
- **Fees (`beforeSwap`):** a per-pool static fee, optional per-account fee overrides, and an optional dynamic fee bounded by per-pool min/max. Swaps made by the MEV-X Executor pay no LP fee.
- **Backrun (`afterSwap`):** runs the arbitrage in a gas-capped self-call that never reverts the user's swap. The one exception is hard mode: there, the swap reverts when the backrun ran out of gas because the transaction did not provide enough.
- **Profit:** the backrun profit is split between the pool's LPs, by donation to the pool with a per-pool share, and the Profit Distributor.
- **Roles:** OpenZeppelin `AccessControlDefaultAdminRules`, plus per-pool fee manager and pool admin roles.

Audit scope, call flow, roles and trust assumptions: [docs/audit/SCOPE.md](docs/audit/SCOPE.md).

## Build and test

```
yarn install                               # also initialises the lib/infinity-hooks submodule
yarn compile
yarn test                                  # unit tests, both hooks
BASE_FORK_RPC=<archive RPC> yarn test:fork # Base mainnet fork, live MEV-X Router and Executor
```

Compiler: solc 0.8.26, `viaIR`, optimizer 1 run, EVM `cancun` (as in `hardhat.config.ts`). Commit `90b640e` holds the Pancake hook exactly as deployed: built from it, the creation and runtime bytecode equal the deployed `HomelanderPancakeInfinitySingletonHook` on BNB Chain, Base and Robinhood. Both hooks will be redeployed from the audited commit, since the `BackrunFailed` event was added for the audit.
