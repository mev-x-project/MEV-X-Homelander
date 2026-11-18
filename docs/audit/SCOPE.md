# Audit scope: Homelander singleton hooks

Two singleton hooks share one design:

- `HomelanderUniV4SingletonHook` is the Uniswap V4 hook.
- `HomelanderPancakeInfinitySingletonHook` is the PancakeSwap Infinity CL hook.

Each hook is a single non-upgradeable contract that serves every pool created with it. After every user swap it runs an atomic backrun through the MEV-X stack. It then splits the backrun profit between the pool's LPs and the Profit Distributor.

## In scope

| File | nSLOC | Notes |
| --- | ---: | --- |
| `contracts/singleton_hook/HomelanderUniV4SingletonHook.sol` | 419 | Uniswap V4 hook, inherits v4-periphery `BaseHook` |
| `contracts/singleton_hook/HomelanderPancakeInfinitySingletonHook.sol` | 424 | PancakeSwap Infinity CL hook, same logic as the V4 hook |
| `contracts/singleton_hook/SingletonHookFactory.sol` | 29 | CREATE2 factory that hands the constructor arguments to the hooks |
| `contracts/singleton_hook/interfaces/ISingletonHookFactory.sol` | 7 | |
| `contracts/singleton_hook/interfaces/IMevxDynamicFeeSource.sol` | 13 | |
| `contracts/singleton_hook/interfaces/IMevxExecutorWithStatus.sol` | 10 | |
| `contracts/interfaces/IMevxRouter.sol` | 24 | |
| `contracts/interfaces/IMevxExecutor.sol` | 16 | |
| `contracts/interfaces/IProfitDistributor.sol` | 10 | |
| `contracts/Constants.sol` | 14 | Pool type ids |
| **Total** | **966** | |

The two hooks differ only where the AMMs differ. A plain `diff` of the two files is about 140 lines:

- the base contract (`BaseHook` versus `CLBaseHook`) and how permissions are declared (address bits versus `getHooksRegistrationBitmap`);
- how the pool key is read (`tickSpacing` versus `parameters.getTickSpacing()`);
- the pool data sent to the router;
- settling the LP donation, with the `PoolManager` on V4 and the `Vault` on Infinity.

The Pancake hook inherits PancakeSwap's `CLBaseHook` unchanged from the `lib/infinity-hooks` submodule, pinned to [`pancakeswap/infinity-hooks@644c30f`](https://github.com/pancakeswap/infinity-hooks/blob/644c30f1cb09e4eee04becb6198da1414bdb0e77/src/pool-cl/CLBaseHook.sol).

## Out of scope

- **PancakeSwap `CLBaseHook`.** It comes from the `lib/infinity-hooks` submodule at `644c30f`.
- **Dependencies, pinned in `package.json`:**
  - `@uniswap/v4-core` 1.0.2;
  - `@uniswap/v4-periphery` 1.0.3;
  - `@openzeppelin/contracts` 4.9.6;
  - PancakeSwap `infinity-core` at [`8c8c34a`](https://github.com/pancakeswap/infinity-core/tree/8c8c34ad777ed7a3fb64c5b91a647e6f225a19da), the commit `infinity-hooks@644c30f` builds against.
- **The MEV-X Router, Executor and Profit Distributor.** These are not in this repository. The hooks reach them only through the interfaces listed above. Their expected behaviour is described under "External calls".
- **`HomelanderUniV4Plugin.sol` and `HomelanderAlgebraPlugin.sol`.** These are the earlier per-pool plugins, already audited (see the README).
- **`contracts/test/**`.** Mocks and test routers, used only by the tests.

## Build and tests

```
yarn install                               # also initialises the lib/infinity-hooks submodule
yarn compile
yarn test                                  # unit tests, local network
BASE_FORK_RPC=<archive RPC> yarn test:fork # Base mainnet fork against the live MEV-X stack
```

- **Compiler:** solc 0.8.26, `viaIR`, optimizer 1 run, EVM `cancun`.
- **OpenZeppelin versions:** PancakeSwap's `Vault` needs OpenZeppelin 5, while the hooks use 4.9.6. The `Vault` is compiled only for the local test stack, and `hardhat.config.ts` points `infinity-core` sources at an OpenZeppelin 5 alias. The hooks' own compilation unit uses only 4.9.6.
- **Unit tests (`test/unit`):** the same suite runs against both hooks. Each hook runs on a real PoolManager, or a real Vault plus CLPoolManager, deployed locally. The MEV-X side is replaced by mocks in `contracts/test`:
  - The router mock returns configurable answers, can revert or burn its gas on each call, and records its arguments.
  - The executor mock swaps back on the hook's pool from inside the user's unlock or lock, as the real executor does, and pays a configured profit.
  - The distributor mock records its calls and can revert.
- **Fork tests (`test/fork`):** they fork Base at a fixed block.
  1. Replace the code at the live hook addresses with the code built from this repository. Storage layout and immutables are unchanged.
  2. Create a WETH/USDC pool on each hook.
  3. Set a route book in the live router for the cycle through that pool and the Uniswap V3 WETH/USDC pool.
  4. Check that a user swap is backrun by the live router and executor: fee-free executor swap, `ProfitShared`, LP donation and distributor share.

## Call flow

1. **`beforeInitialize`.** Only dynamic-fee pools are accepted (`fee == 0x800000`). Pool creation is permissionless.
2. **`afterInitialize`.** The hook stores the pool key and creates the pool config from the defaults. The static fee comes from `feeByTickSpacing`, or the default fee. The hook then calls `router.initializePoolExternally(poolId, poolType, packedKey)` with `callGasBudget` gas and ignores the result.
3. **`beforeSwap`.** The hook returns `getFee(...) | OVERRIDE_FEE_FLAG`. `getFee` is checked in this order:
   1. The executor pays 0.
   2. A per-pool override for `tx.origin`, then one for the pool manager caller. Overrides are stored as `fee + 1`, and 0 means no override.
   3. If the pool enabled it, a dynamic fee from `router.getDynamicFee`. This is a `staticcall` with `callGasBudget` gas. The result is clamped to the pool's bounds, and any failure falls back to the static fee.
   4. The pool's static fee.
4. **`afterSwap` when the caller is the executor** (its own backrun swap). The hook calls `router.initialArbCheck(poolId, !zeroForOne)` with `callGasBudget` gas, so the router can cache the new price, and returns. No nested backrun runs.
5. **`afterSwap` for any other caller.** The hook calls `this.runArbitrage(...)` with `callGasBudget` gas. Inside the call:
   1. `router.initialArbCheck`. If there is no arbitrage, the hook stops.
   2. `router.constructArbitrageRoute(poolId, zeroForOne, arbData, -delta.amount0, -delta.amount1)`. If it reports no route, the hook stops.
   3. `executor.executeRouteWithStatus(route, pools, amountIn, profitToken, hook)` inside try/catch.
   4. The profit is the hook's balance increase in `profitToken`.
   5. `profit * lpShareBps / 10000` is donated to the pool (`donate` followed by `sync`/`settle`, inside the swapper's unlock or lock). If the profit token is not one of the pool's currencies, or the donation fails, nothing is donated.
   6. The rest is transferred, or sent as native currency, to the distributor, and `distributeProfit(poolId, token, sender)` is called inside try/catch.
   7. The hook emits `ProfitShared(poolId, token, donatedToLps, sentToDistributor)`.
   8. `runArbitrage` returns `failed`. It is true when the router or executor failed after an arbitrage was found.
   9. If `runArbitrage` reverted or returned `failed`, the hook emits `BackrunFailed(poolId, reverted, outOfGas)` outside the self-call, unless hard mode reverts the swap (next step). `outOfGas` is the hard-mode condition: the transaction left the backrun short of its budget and the backrun ran out of gas. In soft mode it marks the swaps that went through without a backrun because of the transaction's gas limit.
6. **Hard mode** (per pool, off by default). The swap reverts with `Insufficient gas for afterSwap hook` only when all three conditions hold:
   - the backrun failed;
   - the gas available to it was less than `callGasBudget`, so the transaction did not provide enough gas;
   - the call returned at most `(1 + outOfGasDepth)/64` of the gas, so it ran out of gas rather than failing.

   `outOfGasDepth` (default 8) covers an out of gas that happens several call frames below the hook. If the transaction provided the full budget, hard mode never reverts the swap.

## Roles

The hooks use OpenZeppelin `AccessControlDefaultAdminRules` with a transfer delay of 0. The admin, `owner()`, holds every role.

| Role | Granted as | Can |
| --- | --- | --- |
| `DEFAULT_ADMIN_ROLE` | single account, two-step transfer | set router, executor and distributor; defaults; fee per tick spacing; default out-of-gas depth; everything below |
| `FEE_MANAGER_ROLE` | globally, or for one pool as `poolRole(role, poolId)` | static fee, dynamic fee on/off and bounds, fee overrides |
| `POOL_ADMIN_ROLE` | globally, or for one pool | LP share, hard mode, call gas budget, out-of-gas depth |

`SingletonHookFactory` is `Ownable2Step`. Only the owner deploys, and ownership cannot be renounced. The hook reads its parameters from `factory.parameters()` in its constructor, so its address depends only on the factory, the salt and the creation code. The factory deletes the parameters after the deployment.

## External calls and trust assumptions

- **Router, executor and distributor are trusted.** They are set by the admin. They are called with a gas cap, and their failures are swallowed. A misbehaving router can still waste up to `callGasBudget` of the swapper's gas per call, and in hard mode it can make swaps revert when the transaction is short of the budget.
- **The executor is trusted with the pool's zero fee.** Its swaps on the pool pay no LP fee and never trigger a backrun. An AMM-level protocol fee still applies. On PancakeSwap Infinity on Base, for example, the executor's swap event shows `fee == protocolFee`.
- **Profit is measured as the hook's balance increase** during `executeRouteWithStatus`. Tokens or native currency sent to the hook outside a backrun stay in the hook, which has no sweep function. `receive()` is open because native profit and native donations pass through the hook.
- **`getDynamicFee` is optional.** The live MEV-X Router does not implement it, so pools that enable the dynamic fee keep paying the static fee. The call is a `staticcall`, so it cannot change state.
- **`distributeProfit` failures are swallowed.** The tokens have already been transferred to the distributor at that point.
- **The donation goes to the LPs in range at the current tick.** As with any `donate`, just-in-time liquidity can capture part of it.
- **Fee overrides look at `tx.origin` first.** This is a "wallet tier" that applies whatever router the wallet uses.
- **Soft mode and a router that burns its whole budget.** If the router or executor burns all of its gas, and the transaction gave the backrun less than its budget, the 1/64 gas left may not be enough to finish the swap. The transaction then runs out of gas, which the EVM cannot prevent. The live router stops before using its whole budget. The unit test `hard mode / soft mode` shows both modes at different transaction gas limits.

## Deployments

The hooks and the factory are deployed at the same address on every chain:

| Contract | Address | Chains |
| --- | --- | --- |
| `SingletonHookFactory` | `0xB972d7effAe885202C0DE695108fd659fe0C7f40` | Ethereum, Base, BNB Chain, Robinhood |
| `HomelanderUniV4SingletonHook` | `0x4F0067581931d9205E848862a7042b5EBc11f0c0` | Ethereum, Base, BNB Chain, Robinhood |
| `HomelanderPancakeInfinitySingletonHook` | `0x5c9717DD21055c40b498F9F38CCe91FC3AAEf2B8` | Base, BNB Chain, Robinhood |

- **UniV4 hook:** deployed from the source in commit `8213de9`, which has no `BackrunFailed` event. The deployment was compiled from another repository layout, and source paths are part of the metadata, so the metadata hash differs too. It will be redeployed from the audited commit.
- **Pancake hook:** commit `90b640e` holds the deployed version at its original paths. Built from that commit, the creation and runtime bytecode equal the deployed ones on BNB Chain, Base and Robinhood. The next commit, `3b45e75`, is the change to the audited version: comments removed, `CLBaseHook` from the submodule, `BackrunFailed` added. It will be redeployed from the audited commit.
