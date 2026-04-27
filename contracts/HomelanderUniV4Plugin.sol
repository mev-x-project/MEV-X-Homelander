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
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {Constants} from "./Constants.sol";
import {IMevxExecutor} from "./interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "./interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "./interfaces/IProfitDistributor.sol";

contract HomelanderUniV4Plugin is BaseHook, Ownable2Step {
	/// @dev Uniswap v4 dynamic-fee sentinel + default LP fee (fee pips).
	/// Encoding: `dynamicFee = 0x800000 | defaultFeePips`.
	uint24 public immutable dynamicFee;

	bytes32 public configId;
	IProfitDistributor public profitDistributor;
	IMevxExecutor public mevxExecutor;
	IMevxRouter public mevxRouter;
	uint256 public minGasLeft;

	uint256 public constant MAX_MIN_GAS_LEFT = 1_500_000;

	event ConfigIdSet(bytes32 oldConfigId, bytes32 newConfigId);
	event ProfitDistributorSet(address oldProfitDistributor, address newProfitDistributor);
	event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
	event MevxRouterSet(address oldMevxRouter, address newMevxRouter);
	event MinGasLeftSet(uint256 oldMinGasLeft, uint256 newMinGasLeft);

	constructor(
		IPoolManager _poolManager,
		address owner_,
		address mevxRouter_,
		address mevxExecutor_,
		address profitDistributor_,
		uint24 dynamicFee_
	) BaseHook(_poolManager) {
		require(owner_ != address(0), "owner is zero address");
		require(mevxRouter_ != address(0), "mevxRouter is zero address");
		require(mevxExecutor_ != address(0), "mevxExecutor is zero address");
		require(profitDistributor_ != address(0), "profitDistributor is zero address");

		_transferOwnership(owner_);
		mevxExecutor = IMevxExecutor(mevxExecutor_);
		mevxRouter = IMevxRouter(mevxRouter_);
		profitDistributor = IProfitDistributor(profitDistributor_);

		if (dynamicFee_ & LPFeeLibrary.DYNAMIC_FEE_FLAG != 0) {
			uint24 defaultFeePips = dynamicFee_ & 0x7FFFFF;
			require(defaultFeePips <= LPFeeLibrary.MAX_LP_FEE, "Invalid defaultFeePips");
		} else {
			require(dynamicFee_ == 0, "dynamicFee must be 0 when dynamicFee flag is not set");
		}

		dynamicFee = dynamicFee_;
	}

	function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
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

	function setProfitDistributor(IProfitDistributor _profitDistributor) external onlyOwner {
		require(address(_profitDistributor) != address(0), "profitDistributor is zero address");
		address oldProfitDistributor = address(profitDistributor);
		profitDistributor = _profitDistributor;
		emit ProfitDistributorSet(oldProfitDistributor, address(_profitDistributor));
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

	function renounceOwnership() public view override onlyOwner {
		revert("Ownership cannot be renounced");
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
			return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
		}

		uint24 defaultFeePips = dynamicFee & 0x7FFFFF;
		uint24 feeToUse = sender == address(mevxExecutor) ? 0 : defaultFeePips;

		return (
			BaseHook.beforeSwap.selector,
			BeforeSwapDeltaLibrary.ZERO_DELTA,
			LPFeeLibrary.OVERRIDE_FEE_FLAG | feeToUse
		);
	}

	function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
		bytes32 poolId = PoolId.unwrap(key.toId());
		bytes memory data = abi.encodePacked(
			Currency.unwrap(key.currency0),
			Currency.unwrap(key.currency1),
			key.fee,
			key.tickSpacing,
			address(key.hooks)
		);
		try mevxRouter.initializePoolExternally(poolId, Constants.UNISWAP_V4_POOL_TYPE, data) {} catch {}

		return BaseHook.afterInitialize.selector;
	}

	function _afterSwap(
		address sender,
		PoolKey calldata key,
		SwapParams calldata params,
		BalanceDelta delta,
		bytes calldata
	) internal override returns (bytes4, int128) {
		bytes32 poolId = PoolId.unwrap(key.toId());

		bytes memory initialArbCheckCallData = abi.encodeWithSelector(
			IMevxRouter.initialArbCheck.selector,
			poolId,
			!params.zeroForOne
		);

		(bool successInitialArbCheck, bytes memory returnDataInitialArbCheck) = address(mevxRouter).call(
			initialArbCheckCallData
		);

		// Intentionally after initialArbCheck
		if (sender == address(mevxExecutor)) {
			return (BaseHook.afterSwap.selector, 0);
		}

		require(gasleft() >= minGasLeft, "Insufficient gas for afterSwap hook");

		if (!successInitialArbCheck || returnDataInitialArbCheck.length != 64) {
			return (BaseHook.afterSwap.selector, 0);
		}

		bytes16 arbData;
		bool isArbPossible;

		(isArbPossible, arbData) = abi.decode(returnDataInitialArbCheck, (bool, bytes16));

		if (!isArbPossible) {
			return (BaseHook.afterSwap.selector, 0);
		}

		bytes memory callData = abi.encodeWithSelector(
			IMevxRouter.constructArbitrageRoute.selector,
			poolId,
			params.zeroForOne,
			arbData,
			-delta.amount0(),
			-delta.amount1()
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
				try profitDistributor_.distributeProfit(configId, profitToken, sender) {} catch {}
			} catch {}
		}

		return (BaseHook.afterSwap.selector, 0);
	}
}
