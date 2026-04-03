// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

contract HomelanderUniV4Plugin is BaseHook, Ownable {
    /// @dev Uniswap v4 dynamic-fee sentinel + default LP fee (fee pips).
    /// Encoding: `dynamicFee = 0x800000 | defaultFeePips`.
    uint24 public immutable dynamicFee;

    bytes32 public configId;
    IProfitDistributor public profitDistributor;
    IMevxExecutor public mevxExecutor;
    IMevxRouter public mevxRouter;

    event ConfigIdSet(bytes32 oldConfigId, bytes32 newConfigId);
    event ProfitDistributorSet(
        address oldProfitDistributor,
        address newProfitDistributor
    );
    event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
    event MevxRouterSet(address oldMevxRouter, address newMevxRouter);

    constructor(
        IPoolManager _poolManager,
        address owner_,
        address mevxRouter_,
        address mevxExecutor_,
        address profitDistributor_,
        uint24 dynamicFee_
    ) BaseHook(_poolManager) {
        _transferOwnership(owner_);
        mevxExecutor = IMevxExecutor(mevxExecutor_);
        mevxRouter = IMevxRouter(mevxRouter_);
        profitDistributor = IProfitDistributor(profitDistributor_);

        // Validate defaultFeePips only when enabled.
        if (dynamicFee_ & LPFeeLibrary.DYNAMIC_FEE_FLAG != 0) {
            uint24 defaultFeePips = dynamicFee_ & 0x7FFFFF;
            require(
                defaultFeePips <= LPFeeLibrary.MAX_LP_FEE,
                "Invalid defaultFeePips"
            );
        }
        dynamicFee = dynamicFee_;
    }

    /// @dev Skip address validation — in production deploy via CREATE2 to an address
    /// matching getHookPermissions(). In tests use hardhat_setCode.
    function validateHookAddress(BaseHook) internal pure override {}

    function getHookPermissions()
        public
        pure
        override
        returns (Hooks.Permissions memory)
    {
        return
            Hooks.Permissions({
                beforeInitialize: false,
                afterInitialize: true,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: false,
                afterSwapReturnDelta: false,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            });
    }

    // ──────────────────── Admin ────────────────────

    function setConfigId(bytes32 _configId) external onlyOwner {
        bytes32 oldConfigId = configId;
        configId = _configId;
        emit ConfigIdSet(oldConfigId, _configId);
    }

    function setProfitDistributor(
        IProfitDistributor _profitDistributor
    ) external onlyOwner {
        address oldProfitDistributor = address(profitDistributor);
        profitDistributor = _profitDistributor;
        emit ProfitDistributorSet(
            oldProfitDistributor,
            address(_profitDistributor)
        );
    }

    function setMevxExecutor(IMevxExecutor _mevxExecutor) external onlyOwner {
        address oldMevxExecutor = address(mevxExecutor);
        mevxExecutor = _mevxExecutor;
        emit MevxExecutorSet(oldMevxExecutor, address(_mevxExecutor));
    }

    function setMevxRouter(IMevxRouter _mevxRouter) external onlyOwner {
        address oldMevxRouter = address(mevxRouter);
        mevxRouter = _mevxRouter;
        emit MevxRouterSet(oldMevxRouter, address(_mevxRouter));
    }

    // ──────────────────── Hooks ────────────────────

    function _beforeSwap(
        address sender,
        PoolKey calldata,
        SwapParams calldata,
        bytes calldata
    ) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
        // Feature disabled => no fee override
        if (dynamicFee & LPFeeLibrary.DYNAMIC_FEE_FLAG == 0) {
            return (
                BaseHook.beforeSwap.selector,
                BeforeSwapDeltaLibrary.ZERO_DELTA,
                0
            );
        }

        uint24 defaultFeePips = dynamicFee & 0x7FFFFF;
        uint24 feeToUse = sender == address(mevxExecutor) ? 0 : defaultFeePips;

        return (
            BaseHook.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            LPFeeLibrary.OVERRIDE_FEE_FLAG | feeToUse
        );
    }

    function _afterInitialize(
        address,
        PoolKey calldata key,
        uint160,
        int24
    ) internal override returns (bytes4) {
        bytes32 poolId = PoolId.unwrap(key.toId());
        bytes memory data = abi.encodePacked(
            Currency.unwrap(key.currency0),
            Currency.unwrap(key.currency1),
            key.fee,
            key.tickSpacing,
            address(key.hooks)
        );
        try
            mevxRouter.initializePoolExternally(
                poolId,
                Constants.UNISWAP_V4_POOL_TYPE,
                data
            )
        {} catch {}

        return BaseHook.afterInitialize.selector;
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        bool isArbPossible;
        address profitToken;
        address[] memory pools;
        uint256 amountIn;
        bytes memory encodedRoute;

        bytes32 poolId = PoolId.unwrap(key.toId());

        bytes memory callData = abi.encodeWithSelector(
            IMevxRouter.constructArbitrageRoute.selector,
            poolId,
            params.zeroForOne,
            -delta.amount0(),
            -delta.amount1()
        );

        (bool success, bytes memory returnData) = address(mevxRouter).call(
            callData
        );

        if (success && returnData.length > 0) {
            (isArbPossible, profitToken, pools, amountIn, encodedRoute) = abi
                .decode(returnData, (bool, address, address[], uint256, bytes));
        }

        if (isArbPossible) {
            try
                mevxExecutor.executeRoute(
                    encodedRoute,
                    pools,
                    amountIn,
                    profitToken,
                    address(profitDistributor)
                )
            {
                try
                    profitDistributor.distributeProfit(
                        configId,
                        profitToken,
                        sender
                    )
                {} catch {}
            } catch {}
        }

        return (BaseHook.afterSwap.selector, 0);
    }
}
