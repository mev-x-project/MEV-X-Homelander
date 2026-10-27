# MEV-X Homelander

MEV-X Homelander is an on-chain, atomic MEV internalization module for DEXs that executes backrun opportunities within the originating transaction and retains the resulting value inside the protocol's economic domain. It integrates through the AMM's post-swap hook, which serves as the trigger for entering Homelander's internal execution path. The contracts in this repository cover only the hook-facing component and related interfaces used during audit. For a broader overview of the protocol, motivation, and design rationale, see the [MEV-X Homelander GitBook](https://mx0-1.gitbook.io/mev-x-homelander/the-scale-of-mev-leakage).

Homelander supports integration with **Algebra Integral** and **Uniswap V4** pools, hooking into each AMM's native post-swap callback mechanism.

## Audits

Homelander has been independently audited for both supported AMM integrations:

- **Uniswap V4 integration** — audited by MixBytes:
  [https://github.com/mixbytes/audits_public/tree/master/MEV-X/Homelander](https://github.com/mixbytes/audits_public/tree/master/MEV-X/Homelander)

- **Algebra Integral integration** — audited by BailSec:
  [Bailsec - MEV-X - Plugin - Final Report.pdf](https://github.com/bailsec/BailSec/blob/main/Bailsec%20-%20MEV-X%20-%20Plugin%20-%20Final%20Report.pdf)

## System Components

The full Homelander execution stack consists of four on-chain components:

- **Plugin:** Implements the post-swap hook (`afterSwap`) and serves as the entrypoint for MEV internalization. The plugin inspects the finalized pool state and interacts with the MEV-X execution stack. Two plugin variants are provided — one for Algebra Integral pools and one for Uniswap V4 pools — sharing the same internal execution path. This repository contains only this component and the interfaces required for external integration.

- **MEV-X Router:** Stores precomputed arbitrage routes for supported pools and performs lightweight validation of whether a profitable opportunity exists. When triggered via `afterSwap`, it returns execution data for the relevant route.

- **MEV-X Executor:** Executes the internal arbitrage using the route data provided by the MEV-X Router. All swaps are performed atomically within the originating transaction.

- **Profit Distributor:** Handles allocation of extracted value according to the configured distribution model.

## Uniswap V4 Singleton Hook

`contracts/singleton_hook/HomelanderUniV4SingletonHook.sol` is a single, non-upgradeable Uniswap V4 hook that serves every pool created with it. It is deployed by `SingletonHookFactory` (through CreateX) at the same address on every chain:

| Contract | Address |
| --- | --- |
| `HomelanderUniV4SingletonHook` | `0x4F0067581931d9205E848862a7042b5EBc11f0c0` |
| `SingletonHookFactory` | `0xB972d7effAe885202C0DE695108fd659fe0C7f40` |

Chains: Ethereum, Base, BNB Chain, Robinhood.

Hook permissions: `beforeInitialize`, `afterInitialize`, `beforeSwap`, `afterSwap`. No return-delta permissions, so the hook never takes or adds tokens to a swap.

- **Pools:** dynamic-fee pools only (`fee = 0x800000`). On `afterInitialize` the hook stores the pool's config (static fee by tick spacing or the default, call gas budget, hard mode, LP share) and registers the pool with the MEV-X Router.
- **Fees (`beforeSwap`):** per-pool static fee, optional per-account fee overrides, and an optional dynamic fee bounded by per-pool min/max. Swaps made by the MEV-X Executor pay no fee.
- **Backrun (`afterSwap`):** runs the arbitrage in a gas-capped self-call that never reverts the user's swap. In hard mode only, the swap reverts when the backrun ran out of gas because the transaction did not provide enough.
- **Profit:** the backrun profit is split between the pool's LPs (donated to the pool, per-pool share) and the Profit Distributor.
- **Roles:** OpenZeppelin `AccessControlDefaultAdminRules`; per-pool fee manager and pool admin roles.

Compiler: solc 0.8.26, `viaIR`, optimizer 1 run, EVM `cancun` (as in `hardhat.config.ts`). The compiled bytecode matches the deployed contracts.
