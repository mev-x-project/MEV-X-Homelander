// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraFactory.sol";
import "@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraPool.sol";
import "@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPlugin.sol";
import "@cryptoalgebra/integral-core/contracts/libraries/Plugins.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

contract MevxPlugin is IAlgebraPlugin, Ownable {
    using Plugins for uint8;

    uint8 public constant defaultPluginConfig =
        uint8(Plugins.AFTER_INIT_FLAG | Plugins.AFTER_SWAP_FLAG);

    bytes32 public configId;
    IProfitDistributor public profitDistributor;
    IMevxExecutor public mevxExecutor;
    IMevxRouter public mevxRouter;

    uint256 public minGasLeft;
    uint256 public callGasBudget;

    uint256 public constant MAX_MIN_GAS_LEFT = 2_500_000;
    uint256 public constant MAX_CALL_GAS_BUDGET = 5_000_000;

    event ConfigIdSet(bytes32 oldConfigId, bytes32 newConfigId);
    event ProfitDistributorSet(
        address oldProfitDistributor,
        address newProfitDistributor
    );
    event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
    event MevxRouterSet(address oldMevxRouter, address newMevxRouter);
    event MinGasLeftSet(uint256 oldMinGasLeft, uint256 newMinGasLeft);
    event CallGasBudgetSet(uint256 oldCallGasBudget, uint256 newCallGasBudget);

    constructor(
        address owner_,
        address mevxRouter_,
        address mevxExecutor_,
        address profitDistributor_
    ) {
        _transferOwnership(owner_);
        mevxExecutor = IMevxExecutor(mevxExecutor_);
        mevxRouter = IMevxRouter(mevxRouter_);
        profitDistributor = IProfitDistributor(profitDistributor_);
        callGasBudget = MAX_CALL_GAS_BUDGET;
    }

    function setPluginConfigToPool(address pool) external onlyOwner {
        IAlgebraPool(pool).setPluginConfig(defaultPluginConfig);
    }

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

    function setMinGasLeft(uint256 minGasLeft_) external onlyOwner {
        require(minGasLeft_ <= MAX_MIN_GAS_LEFT, "minGasLeft too high");
        uint256 oldMinGasLeft = minGasLeft;
        minGasLeft = minGasLeft_;
        emit MinGasLeftSet(oldMinGasLeft, minGasLeft_);
    }

    function setCallGasBudget(uint256 callGasBudget_) external onlyOwner {
        require(callGasBudget_ <= MAX_CALL_GAS_BUDGET, "callGasBudget too high");
        uint256 oldCallGasBudget = callGasBudget;
        callGasBudget = callGasBudget_;
        emit CallGasBudgetSet(oldCallGasBudget, callGasBudget_);
    }

    function afterInitialize(
        address,
        uint160 sqrtPriceX96,
        int24
    ) external override returns (bytes4) {
        bytes memory data = abi.encode(sqrtPriceX96);
        bytes32 poolId = bytes32(uint256(uint160(msg.sender)));
        try
            mevxRouter.initializePoolExternally(poolId, Constants.ALGEBRA_INTEGRAL_POOL_TYPE, data)
        {} catch {}

        return IAlgebraPlugin.afterInitialize.selector;
    }

    function afterSwap(
        address sender,
        address recipient,
        bool zeroToOne,
        int256,
        uint160,
        int256 amount0,
        int256 amount1,
        bytes calldata
    ) external override returns (bytes4) {
        require(gasleft() >= minGasLeft, "Insufficient gas for afterSwap hook");

        bytes32 poolId = bytes32(uint256(uint160(msg.sender)));

        bytes memory branchData = abi.encodeCall(
            this.runArbitrage,
            (poolId, zeroToOne, amount0, amount1, sender, recipient)
        );

        address(this).call{gas: callGasBudget}(branchData);

        return IAlgebraPlugin.afterSwap.selector;
    }

    function runArbitrage(
        bytes32 poolId,
        bool zeroToOne,
        int256 amount0,
        int256 amount1,
        address sender,
        address recipient
    ) external {
        require(msg.sender == address(this), "self only");


        bytes memory initialArbCheckCallData = abi.encodeWithSelector(
            IMevxRouter.initialArbCheck.selector,
            poolId,
            !zeroToOne
        );

        (bool successInitialArbCheck, bytes memory returnDataInitialArbCheck) = address(mevxRouter).call(
            initialArbCheckCallData
        );

        if (sender == address(mevxExecutor)) {
            return;
        }

        if (!successInitialArbCheck || returnDataInitialArbCheck.length != 64) {
            return;
        }

        (bool isArbPossible, bytes16 arbData) = abi.decode(returnDataInitialArbCheck, (bool, bytes16));

        if (!isArbPossible) {
            return;
        }

        bytes memory callData = abi.encodeWithSelector(
            IMevxRouter.constructArbitrageRoute.selector,
            poolId,
            zeroToOne,
            arbData,
            amount0,
            amount1
        );

        address profitToken;
        address[] memory pools;
        uint256 amountIn;
        bytes memory encodedRoute;

        (bool success, bytes memory returnData) = address(mevxRouter).call(callData);
        if (success && returnData.length >= 224) {
            (isArbPossible, profitToken, pools, amountIn, encodedRoute) = abi.decode(
                returnData,
                (bool, address, address[], uint256, bytes)
            );
        }

        IProfitDistributor profitDistributor_ = profitDistributor;

        if (isArbPossible) {
            try mevxExecutor.executeRoute(encodedRoute, pools, amountIn, profitToken, address(profitDistributor_)) {
                try profitDistributor_.distributeProfit(configId, profitToken, recipient) {} catch {}
            } catch {}
        }
    }

    /// @inheritdoc IAlgebraPlugin
    function handlePluginFee(
        uint256,
        uint256
    ) external view override returns (bytes4) {
        return IAlgebraPlugin.handlePluginFee.selector;
    }

    /// @dev unused
    function beforeInitialize(
        address,
        uint160
    ) external override returns (bytes4) {
        return IAlgebraPlugin.beforeInitialize.selector;
    }

    /// @dev unused
    function beforeModifyPosition(
        address,
        address,
        int24,
        int24,
        int128,
        bytes calldata
    ) external view override returns (bytes4, uint24) {
        return (IAlgebraPlugin.beforeModifyPosition.selector, 0);
    }

    /// @dev unused
    function afterModifyPosition(
        address,
        address,
        int24,
        int24,
        int128,
        uint256,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        return IAlgebraPlugin.afterModifyPosition.selector;
    }

    /// @dev unused
    function beforeSwap(
        address,
        address,
        bool,
        int256,
        uint160,
        bool,
        bytes calldata
    ) external view override returns (bytes4, uint24, uint24) {
        return (IAlgebraPlugin.beforeSwap.selector, 0, 0);
    }

    /// @dev unused
    function beforeFlash(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        return IAlgebraPlugin.beforeFlash.selector;
    }

    /// @dev unused
    function afterFlash(
        address,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        return IAlgebraPlugin.afterFlash.selector;
    }
}
