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
