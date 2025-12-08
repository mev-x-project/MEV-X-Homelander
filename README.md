MEV-X Homelander is an on-chain, atomic MEV internalization module for DEXs that executes backrun opportunities within the originating transaction and retains the resulting value inside the protocol’s economic domain. It integrates through the AMM’s post-swap hook, which serves as the trigger for entering Homelander’s internal execution path. The contracts in this repository cover only the hook-facing component and related interfaces used during audit.


## System Components


The full Homelander execution stack consists of four on-chain components:


- **Algebra Plugin:** Implements the post-swap hook (`afterSwap`) and serves as the entrypoint for MEV internalization. The plugin inspects the finalized pool state and interacts with the MEV-X execution stack. This repository contains only this component and the interfaces required for external integration.


- **MEV-X Router:** Stores precomputed arbitrage routes for supported pools and performs lightweight validation of whether a profitable opportunity exists. When triggered via `afterSwap`, it returns execution data for the relevant route.


- **MEV-X Executor:** Executes the internal arbitrage using the route data provided by the MEV-X Router. All swaps are performed atomically within the originating transaction.


- **Profit Distributor:** Handles allocation of extracted value according to the configured distribution model.


Only the Algebra Plugin and its integration interfaces are included in this repository, the remaining components operate externally and are not part of this codebase.


## Audit Scope & Functional Requirements

### Scope
```
contracts/
├── interfaces/
│   ├── IProfitDistributor.sol
│   ├── IMevxRouter.sol
│   └── IMevxExecutor.sol
└── ArbitragePlugin.sol
```
### Functional Requirements
For audit purposes, the expected functional requirements of this contract are the following:


- **The contract must not be able to access or move pool funds.**  
  It should never obtain control over liquidity or token balances and must operate strictly on read-only post-swap data.


- **The contract must not revert user swaps.**  
  If no valid internal backrun exists or any internal check fails, the hook must return without affecting the user’s transaction outcome.



