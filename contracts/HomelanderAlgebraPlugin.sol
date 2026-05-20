// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraPool.sol";
import "@cryptoalgebra/integral-core/contracts/interfaces/plugin/IAlgebraPlugin.sol";
import "@cryptoalgebra/integral-core/contracts/libraries/Plugins.sol";
import {Constants as AlgebraConstants} from "@cryptoalgebra/integral-core/contracts/libraries/Constants.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

contract HomelanderAlgebraPlugin is IAlgebraPlugin, Ownable {
    using Plugins for uint8;
    using SafeERC20 for IERC20;

    uint8 public constant defaultPluginConfig =
        uint8(Plugins.AFTER_INIT_FLAG | Plugins.AFTER_SWAP_FLAG | Plugins.BEFORE_SWAP_FLAG | Plugins.DYNAMIC_FEE);

    bytes32 public configId;
    IProfitDistributor public profitDistributor;
    IMevxExecutor public mevxExecutor;
    IMevxRouter public mevxRouter;
    /// The single Algebra pool this plugin is bound to. One plugin instance == one pool.
    IAlgebraPool public immutable algebraPool;

    mapping(address => bool) public authorizedHandlePluginFeeCallers;

    bool public mevProtectionFeeEnabled;

    uint256 public minGasLeft;
    uint256 public callGasBudget;

    uint16 public defaultFee;

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
    event DefaultFeeSet(uint16 oldDefaultFee, uint16 newDefaultFee);
    event AuthorizedHandlePluginFeeCallerSet(address indexed caller, bool authorized);
    event MevProtectionFeeEnabledSet(bool oldEnabled, bool newEnabled);

    constructor(
        address owner_,
        address mevxRouter_,
        address mevxExecutor_,
        address profitDistributor_,
        address algebraPool_,
        uint16 defaultFee_
    ) {
        require(owner_ != address(0), "owner is zero address");
        require(mevxRouter_ != address(0), "mevxRouter is zero address");
        require(mevxExecutor_ != address(0), "mevxExecutor is zero address");
        require(profitDistributor_ != address(0), "profitDistributor is zero address");
        require(algebraPool_ != address(0), "algebraPool is zero address");
        require(defaultFee_ <= AlgebraConstants.MAX_DEFAULT_FEE, "defaultFee too high");
        _transferOwnership(owner_);
        mevxExecutor = IMevxExecutor(mevxExecutor_);
        mevxRouter = IMevxRouter(mevxRouter_);
        profitDistributor = IProfitDistributor(profitDistributor_);
        algebraPool = IAlgebraPool(algebraPool_);
        callGasBudget = MAX_CALL_GAS_BUDGET;
        defaultFee = defaultFee_;
    }

    function setPluginConfigToPool() external onlyOwner {
        algebraPool.setPluginConfig(defaultPluginConfig);
    }

    function setConfigId(bytes32 _configId) external onlyOwner {
        bytes32 oldConfigId = configId;
        configId = _configId;
        emit ConfigIdSet(oldConfigId, _configId);
    }

    function setProfitDistributor(
        IProfitDistributor _profitDistributor
    ) external onlyOwner {
        require(address(_profitDistributor) != address(0), "profitDistributor is zero address");

        address oldProfitDistributor = address(profitDistributor);
        profitDistributor = _profitDistributor;
        emit ProfitDistributorSet(
            oldProfitDistributor,
            address(_profitDistributor)
        );
    }

    function setMevxExecutor(IMevxExecutor _mevxExecutor) external onlyOwner {
        require(address(_mevxExecutor) != address(0), "mevxExecutor is zero address");

        address oldMevxExecutor = address(mevxExecutor);
        mevxExecutor = _mevxExecutor;
        emit MevxExecutorSet(oldMevxExecutor, address(_mevxExecutor));
    }

    function setMevxRouter(IMevxRouter _mevxRouter) external onlyOwner {
        require(address(_mevxRouter) != address(0), "mevxRouter is zero address");

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

    function setDefaultFee(uint16 defaultFee_) external onlyOwner {
        require(defaultFee_ <= AlgebraConstants.MAX_DEFAULT_FEE, "defaultFee too high");
        uint16 oldDefaultFee = defaultFee;
        defaultFee = defaultFee_;
        emit DefaultFeeSet(oldDefaultFee, defaultFee_);
    }

    function setAuthorizedHandlePluginFeeCaller(address caller, bool authorized) external onlyOwner {
        require(caller != address(0), "caller is zero address");
        authorizedHandlePluginFeeCallers[caller] = authorized;
        emit AuthorizedHandlePluginFeeCallerSet(caller, authorized);
    }

    function setMevProtectionFeeEnabled(bool enabled) external onlyOwner {
        bool oldEnabled = mevProtectionFeeEnabled;
        mevProtectionFeeEnabled = enabled;
        emit MevProtectionFeeEnabledSet(oldEnabled, enabled);
    }

    function afterInitialize(
        address,
        uint160 sqrtPriceX96,
        int24
    ) external override returns (bytes4) {
        bytes memory data = abi.encode(sqrtPriceX96);
        bytes32 poolId = bytes32(uint256(uint160(address(algebraPool))));

		bytes memory initData = abi.encodeCall(
			IMevxRouter.initializePoolExternally,
			(poolId, Constants.ALGEBRA_INTEGRAL_POOL_TYPE, data)
		);

        address(mevxRouter).call{gas: callGasBudget}(initData);

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
        _afterSwap(address(algebraPool), sender, recipient, zeroToOne, amount0, amount1);
        return IAlgebraPlugin.afterSwap.selector;
    }

    function _afterSwap(
        address pool,
        address sender,
        address recipient,
        bool zeroToOne,
        int256 amount0,
        int256 amount1
    ) internal {
        if (sender != address(mevxExecutor)) {
            require(gasleft() >= minGasLeft, "Insufficient gas for afterSwap hook");
        }

        bytes32 poolId = bytes32(uint256(uint160(pool)));

        bytes memory branchData = abi.encodeCall(
            this.runArbitrage,
            (poolId, zeroToOne, amount0, amount1, sender, recipient)
        );

        address(this).call{gas: callGasBudget}(branchData);
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

    /// @notice Returns the indicative pool fee as `defaultFee + pluginFee`, exposed for
    /// Algebra's dynamic-fee view path (`AlgebraPool.fee()`) and for off-chain quoting.
    /// @dev The value returned here may differ from the fee actually charged by a swap.
    /// Consider calling it atomically right before the swap if a
    /// precise figure is required.
    function getCurrentFee() external view returns (uint16) {
        uint16 currentFee = defaultFee;

        bytes memory callData = abi.encodeWithSelector(
            IMevxRouter.getMevProtectionFee.selector,
            currentFee
        );

        (bool success, bytes memory returnData) = address(mevxRouter)
            .staticcall{gas: callGasBudget}(callData);
        uint24 pluginFee = 0;

        if (success && returnData.length == 32) {
            pluginFee = abi.decode(returnData, (uint24));
            if (pluginFee > AlgebraConstants.MAX_DEFAULT_FEE) {
                pluginFee = 0;
            }
        }

        return uint16(currentFee + pluginFee);
    }

	function beforeSwap(
        address sender,
        address,
        bool,
        int256,
        uint160,
        bool,
        bytes calldata
    ) external view override returns (bytes4, uint24, uint24) {
        if (sender == address(mevxExecutor)) {
            return (IAlgebraPlugin.beforeSwap.selector, 1, 0);
        }
        if (!mevProtectionFeeEnabled) {
            return (IAlgebraPlugin.beforeSwap.selector, 0, 0);
        }
        uint16 currentFee = defaultFee;

        bytes memory callData = abi.encodeWithSelector(
            IMevxRouter.getMevProtectionFee.selector,
            currentFee
        );

        (bool success, bytes memory returnData) = address(mevxRouter).staticcall{gas: callGasBudget}(callData);
        uint24 pluginFee = 0;

        if (success && returnData.length == 32) {
            pluginFee = abi.decode(returnData, (uint24));
            if (pluginFee > AlgebraConstants.MAX_DEFAULT_FEE) {
                pluginFee = 0;
            }
        }

        return (IAlgebraPlugin.beforeSwap.selector, currentFee, pluginFee);
    }

    /// @inheritdoc IAlgebraPlugin
    function handlePluginFee(
        uint256 pluginFee0,
        uint256 pluginFee1
    ) external override returns (bytes4) {
        require(
            msg.sender == address(algebraPool) || authorizedHandlePluginFeeCallers[msg.sender],
            "not authorized"
        );
        address token0 = algebraPool.token0();
        address token1 = algebraPool.token1();

        address recipient = address(profitDistributor);
        if (pluginFee0 > 0) {
            IERC20(token0).safeTransfer(recipient, pluginFee0);
            try profitDistributor.distributeProfit(configId, token0, address(0)) {} catch {}
        }
        if (pluginFee1 > 0) {
            IERC20(token1).safeTransfer(recipient, pluginFee1);
            try profitDistributor.distributeProfit(configId, token1, address(0)) {} catch {}
        }
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
