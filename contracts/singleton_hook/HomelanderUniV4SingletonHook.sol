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
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Constants} from "../Constants.sol";
import {IMevxExecutor} from "../interfaces/IMevxExecutor.sol";
import {IMevxRouter} from "../interfaces/IMevxRouter.sol";
import {IProfitDistributor} from "../interfaces/IProfitDistributor.sol";
import {IMevxDynamicFeeSource} from "./interfaces/IMevxDynamicFeeSource.sol";
import {IMevxExecutorWithStatus} from "./interfaces/IMevxExecutorWithStatus.sol";
import {ISingletonHookFactory} from "./interfaces/ISingletonHookFactory.sol";

contract HomelanderUniV4SingletonHook is BaseHook, AccessControlDefaultAdminRules {
	using LPFeeLibrary for uint24;
	using SafeERC20 for IERC20;

	uint256 public constant MAX_CALL_GAS_BUDGET = 5_000_000;
	uint256 public constant BPS_DENOMINATOR = 10_000;
	uint8 public constant MAX_OUT_OF_GAS_DEPTH = 32;

	// granted for one pool as poolRole(role, poolId), or for all pools as the role itself
	bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
	bytes32 public constant POOL_ADMIN_ROLE = keccak256("POOL_ADMIN_ROLE");

	struct PoolConfig {
		bool initialized;
		uint24 staticFee;
		bool dynamicFeeEnabled;
		uint24 dynamicFeeMin;
		uint24 dynamicFeeMax;
		bool hardMode;
		uint16 lpShareBps;
		uint32 callGasBudget;
		uint8 outOfGasDepth;
		uint16 overriddenFeeCount;
	}

	struct Parameters {
		IPoolManager poolManager;
		address owner;
		address mevxRouter;
		address mevxExecutor;
		address profitDistributor;
		uint24 defaultFee;
		uint16 defaultLpShareBps;
	}

	IMevxExecutor public mevxExecutor;
	IMevxRouter public mevxRouter;
	IProfitDistributor public profitDistributor;

	uint24 public defaultFee;
	uint16 public defaultLpShareBps;
	uint32 public defaultCallGasBudget;
	bool public defaultHardMode;
	uint24 public defaultDynamicFeeMin;
	uint24 public defaultDynamicFeeMax;
	uint8 public defaultOutOfGasDepth;
	mapping(int24 tickSpacing => uint24 fee) public feeByTickSpacing;

	mapping(bytes32 poolId => PoolConfig) public poolConfig;
	mapping(bytes32 poolId => PoolKey) internal _poolKeys;
	// fee + 1, 0 = no override
	mapping(bytes32 poolId => mapping(address account => uint24 feePlusOne)) public feeOverridePlusOne;


	event ProfitDistributorSet(address oldProfitDistributor, address newProfitDistributor);
	event MevxExecutorSet(address oldMevxExecutor, address newMevxExecutor);
	event MevxRouterSet(address oldMevxRouter, address newMevxRouter);
	event DefaultsSet(uint24 fee, uint16 lpShareBps, uint32 callGasBudget, bool hardMode, uint24 dynamicFeeMin, uint24 dynamicFeeMax);
	event FeeForTickSpacingSet(int24 indexed tickSpacing, uint24 oldFee, uint24 newFee);
	event PoolStaticFeeSet(bytes32 indexed poolId, uint24 fee);
	event PoolDynamicFeeSet(bytes32 indexed poolId, bool enabled, uint24 minFee, uint24 maxFee);
	event FeeOverrideSet(bytes32 indexed poolId, address indexed account, uint24 feePlusOne);
	event PoolLpShareSet(bytes32 indexed poolId, uint16 lpShareBps);
	event PoolHardModeSet(bytes32 indexed poolId, bool enabled);
	event PoolCallGasBudgetSet(bytes32 indexed poolId, uint32 callGasBudget);
	event PoolOutOfGasDepthSet(bytes32 indexed poolId, uint8 depth);
	event ProfitShared(bytes32 indexed poolId, address profitToken, uint256 donatedToLps, uint256 sentToDistributor);

	constructor() BaseHook(_parameters().poolManager) AccessControlDefaultAdminRules(0, _parameters().owner) {
		Parameters memory p = _parameters();
		require(p.mevxRouter != address(0), "mevxRouter is zero address");
		require(p.mevxExecutor != address(0), "mevxExecutor is zero address");
		require(p.profitDistributor != address(0), "profitDistributor is zero address");
		require(p.defaultFee <= LPFeeLibrary.MAX_LP_FEE, "invalid fee");
		require(p.defaultLpShareBps <= BPS_DENOMINATOR, "lp share too high");

		mevxRouter = IMevxRouter(p.mevxRouter);
		mevxExecutor = IMevxExecutor(p.mevxExecutor);
		profitDistributor = IProfitDistributor(p.profitDistributor);
		defaultFee = p.defaultFee;
		defaultLpShareBps = p.defaultLpShareBps;
		defaultCallGasBudget = uint32(MAX_CALL_GAS_BUDGET);
		defaultDynamicFeeMax = uint24(LPFeeLibrary.MAX_LP_FEE);
		defaultOutOfGasDepth = 8;

		_setFeeForTickSpacing(1, 100);
		_setFeeForTickSpacing(10, 500);
		_setFeeForTickSpacing(50, 2500);
		_setFeeForTickSpacing(60, 3000);
		_setFeeForTickSpacing(200, 10000);
	}

	function _parameters() private view returns (Parameters memory) {
		return abi.decode(ISingletonHookFactory(msg.sender).parameters(), (Parameters));
	}

	receive() external payable {}

	function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
		return
			Hooks.Permissions({
				beforeInitialize: true,
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

	// ──────────────────── Roles ────────────────────

	function poolRole(bytes32 role, bytes32 poolId) public pure returns (bytes32) {
		return keccak256(abi.encode(role, poolId));
	}

	function hasPoolRole(bytes32 role, bytes32 poolId, address account) public view returns (bool) {
		return hasRole(DEFAULT_ADMIN_ROLE, account) || hasRole(role, account) || hasRole(poolRole(role, poolId), account);
	}

	modifier onlyPoolRole(bytes32 role, bytes32 poolId) {
		require(hasPoolRole(role, poolId, msg.sender), "not authorized");
		require(poolConfig[poolId].initialized, "unknown pool");
		_;
	}

	// ──────────────────── Admin ────────────────────

	function setProfitDistributor(IProfitDistributor _profitDistributor) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(address(_profitDistributor) != address(0), "profitDistributor is zero address");
		emit ProfitDistributorSet(address(profitDistributor), address(_profitDistributor));
		profitDistributor = _profitDistributor;
	}

	function setMevxExecutor(IMevxExecutor _mevxExecutor) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(address(_mevxExecutor) != address(0), "mevxExecutor is zero address");
		emit MevxExecutorSet(address(mevxExecutor), address(_mevxExecutor));
		mevxExecutor = _mevxExecutor;
	}

	function setMevxRouter(IMevxRouter _mevxRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(address(_mevxRouter) != address(0), "mevxRouter is zero address");
		emit MevxRouterSet(address(mevxRouter), address(_mevxRouter));
		mevxRouter = _mevxRouter;
	}

	function setDefaults(
		uint24 fee,
		uint16 lpShareBps,
		uint32 callGasBudget,
		bool hardMode,
		uint24 dynamicFeeMin,
		uint24 dynamicFeeMax
	) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(fee <= LPFeeLibrary.MAX_LP_FEE, "invalid fee");
		require(lpShareBps <= BPS_DENOMINATOR, "lp share too high");
		require(callGasBudget <= MAX_CALL_GAS_BUDGET, "callGasBudget too high");
		_checkBounds(dynamicFeeMin, dynamicFeeMax);
		defaultFee = fee;
		defaultLpShareBps = lpShareBps;
		defaultCallGasBudget = callGasBudget;
		defaultHardMode = hardMode;
		defaultDynamicFeeMin = dynamicFeeMin;
		defaultDynamicFeeMax = dynamicFeeMax;
		emit DefaultsSet(fee, lpShareBps, callGasBudget, hardMode, dynamicFeeMin, dynamicFeeMax);
	}

	function setDefaultOutOfGasDepth(uint8 depth) external onlyRole(DEFAULT_ADMIN_ROLE) {
		require(depth <= MAX_OUT_OF_GAS_DEPTH, "depth too high");
		defaultOutOfGasDepth = depth;
	}

	function setFeeForTickSpacing(int24 tickSpacing, uint24 fee) external onlyRole(DEFAULT_ADMIN_ROLE) {
		_setFeeForTickSpacing(tickSpacing, fee);
	}

	function _setFeeForTickSpacing(int24 tickSpacing, uint24 fee) internal {
		require(fee <= LPFeeLibrary.MAX_LP_FEE, "invalid fee");
		emit FeeForTickSpacingSet(tickSpacing, feeByTickSpacing[tickSpacing], fee);
		feeByTickSpacing[tickSpacing] = fee;
	}

	function _checkBounds(uint24 minFee, uint24 maxFee) private pure {
		require(minFee <= maxFee && maxFee <= LPFeeLibrary.MAX_LP_FEE, "invalid bounds");
	}

	// ──────────────────── Fee manager ────────────────────

	function setPoolFee(bytes32 poolId, uint24 fee) external onlyPoolRole(FEE_MANAGER_ROLE, poolId) {
		require(fee <= LPFeeLibrary.MAX_LP_FEE, "invalid fee");
		poolConfig[poolId].staticFee = fee;
		emit PoolStaticFeeSet(poolId, fee);
	}

	function setDynamicFeeEnabled(bytes32 poolId, bool enabled) external onlyPoolRole(FEE_MANAGER_ROLE, poolId) {
		PoolConfig storage c = poolConfig[poolId];
		c.dynamicFeeEnabled = enabled;
		emit PoolDynamicFeeSet(poolId, enabled, c.dynamicFeeMin, c.dynamicFeeMax);
	}

	function setDynamicFeeBounds(bytes32 poolId, uint24 minFee, uint24 maxFee) external onlyPoolRole(FEE_MANAGER_ROLE, poolId) {
		_checkBounds(minFee, maxFee);
		PoolConfig storage c = poolConfig[poolId];
		c.dynamicFeeMin = minFee;
		c.dynamicFeeMax = maxFee;
		emit PoolDynamicFeeSet(poolId, c.dynamicFeeEnabled, minFee, maxFee);
	}

	function setFeeOverride(bytes32 poolId, address account, uint24 feePlusOne) external onlyPoolRole(FEE_MANAGER_ROLE, poolId) {
		require(feePlusOne <= LPFeeLibrary.MAX_LP_FEE + 1, "invalid fee");
		PoolConfig storage c = poolConfig[poolId];
		uint24 old = feeOverridePlusOne[poolId][account];
		if (old == 0 && feePlusOne != 0) c.overriddenFeeCount++;
		else if (old != 0 && feePlusOne == 0) c.overriddenFeeCount--;
		feeOverridePlusOne[poolId][account] = feePlusOne;
		emit FeeOverrideSet(poolId, account, feePlusOne);
	}

	// ──────────────────── Pool admin ────────────────────

	function setLpShareBps(bytes32 poolId, uint16 lpShareBps) external onlyPoolRole(POOL_ADMIN_ROLE, poolId) {
		require(lpShareBps <= BPS_DENOMINATOR, "lp share too high");
		poolConfig[poolId].lpShareBps = lpShareBps;
		emit PoolLpShareSet(poolId, lpShareBps);
	}

	function setHardMode(bytes32 poolId, bool enabled) external onlyPoolRole(POOL_ADMIN_ROLE, poolId) {
		poolConfig[poolId].hardMode = enabled;
		emit PoolHardModeSet(poolId, enabled);
	}

	function setCallGasBudget(bytes32 poolId, uint32 callGasBudget) external onlyPoolRole(POOL_ADMIN_ROLE, poolId) {
		require(callGasBudget <= MAX_CALL_GAS_BUDGET, "callGasBudget too high");
		poolConfig[poolId].callGasBudget = callGasBudget;
		emit PoolCallGasBudgetSet(poolId, callGasBudget);
	}

	function setOutOfGasDepth(bytes32 poolId, uint8 depth) external onlyPoolRole(POOL_ADMIN_ROLE, poolId) {
		require(depth <= MAX_OUT_OF_GAS_DEPTH, "depth too high");
		poolConfig[poolId].outOfGasDepth = depth;
		emit PoolOutOfGasDepthSet(poolId, depth);
	}

	// ──────────────────── Views ────────────────────

	function getHardMode(bytes32 poolId) external view returns (bool) {
		return poolConfig[poolId].hardMode;
	}

	function poolKeys(bytes32 poolId) external view returns (PoolKey memory) {
		return _poolKeys[poolId];
	}

	function getFee(
		bytes32 poolId,
		address sender,
		address origin,
		bool zeroForOne,
		int256 amountSpecified
	) public view returns (uint24) {
		if (sender == address(mevxExecutor)) return 0;
		PoolConfig memory c = poolConfig[poolId];

		if (c.overriddenFeeCount != 0) {
			uint24 overrideFee = feeOverridePlusOne[poolId][origin];
			if (overrideFee == 0) overrideFee = feeOverridePlusOne[poolId][sender];
			if (overrideFee != 0) return overrideFee - 1;
		}

		if (c.dynamicFeeEnabled) {
			(bool ok, bytes memory ret) = address(mevxRouter).staticcall{gas: c.callGasBudget}(
				abi.encodeCall(
					IMevxDynamicFeeSource.getDynamicFee,
					(poolId, sender, origin, zeroForOne, amountSpecified, c.staticFee, c.dynamicFeeMin, c.dynamicFeeMax)
				)
			);
			if (ok && ret.length == 32) {
				uint256 fee = abi.decode(ret, (uint256));
				if (fee < c.dynamicFeeMin) return c.dynamicFeeMin;
				if (fee > c.dynamicFeeMax) return c.dynamicFeeMax;
				return uint24(fee);
			}
		}

		return c.staticFee;
	}

	// ──────────────────── Hooks ────────────────────

	function _beforeInitialize(address, PoolKey calldata key, uint160) internal view override returns (bytes4) {
		require(key.fee.isDynamicFee(), "static fee not allowed");
		return BaseHook.beforeInitialize.selector;
	}

	function _afterInitialize(address, PoolKey calldata key, uint160, int24) internal override returns (bytes4) {
		bytes32 poolId = PoolId.unwrap(key.toId());
		_poolKeys[poolId] = key;

		uint24 fee = feeByTickSpacing[key.tickSpacing];
		uint32 budget = defaultCallGasBudget;
		poolConfig[poolId] = PoolConfig({
			initialized: true,
			staticFee: fee == 0 ? defaultFee : fee,
			dynamicFeeEnabled: false,
			dynamicFeeMin: defaultDynamicFeeMin,
			dynamicFeeMax: defaultDynamicFeeMax,
			hardMode: defaultHardMode,
			lpShareBps: defaultLpShareBps,
			callGasBudget: budget,
			outOfGasDepth: defaultOutOfGasDepth,
			overriddenFeeCount: 0
		});

		bytes memory data = abi.encodePacked(
			Currency.unwrap(key.currency0),
			Currency.unwrap(key.currency1),
			key.fee,
			key.tickSpacing,
			address(key.hooks)
		);
		address(mevxRouter).call{gas: budget}(
			abi.encodeCall(IMevxRouter.initializePoolExternally, (poolId, Constants.UNISWAP_V4_POOL_TYPE, data))
		);

		return BaseHook.afterInitialize.selector;
	}

	function _beforeSwap(
		address sender,
		PoolKey calldata key,
		SwapParams calldata params,
		bytes calldata
	) internal view override returns (bytes4, BeforeSwapDelta, uint24) {
		uint24 fee = getFee(PoolId.unwrap(key.toId()), sender, tx.origin, params.zeroForOne, params.amountSpecified);
		return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, LPFeeLibrary.OVERRIDE_FEE_FLAG | fee);
	}

	function _afterSwap(
		address sender,
		PoolKey calldata key,
		SwapParams calldata params,
		BalanceDelta delta,
		bytes calldata
	) internal override returns (bytes4, int128) {
		bytes32 poolId = PoolId.unwrap(key.toId());
		PoolConfig memory c = poolConfig[poolId];

		if (sender == address(mevxExecutor)) {
			address(mevxRouter).call{gas: c.callGasBudget}(
				abi.encodeCall(IMevxRouter.initialArbCheck, (poolId, !params.zeroForOne))
			);
			return (BaseHook.afterSwap.selector, 0);
		}

		uint256 gasBefore = gasleft();
		(bool success, bytes memory ret) = address(this).call{gas: c.callGasBudget}(
			abi.encodeCall(this.runArbitrage, (poolId, params.zeroForOne, -delta.amount0(), -delta.amount1(), sender))
		);
		uint256 gasAfter = gasleft();

		// hard mode: the arbitrage failed, the swap left it less than its budget and it burned its gas
		// (an out of gas up to outOfGasDepth calls deep hands back at most (1 + depth)/64)
		if (c.hardMode && (!success || abi.decode(ret, (bool)))) {
			bool shortOfBudget = gasBefore - gasBefore / 64 < c.callGasBudget;
			if (shortOfBudget && gasAfter * 64 <= gasBefore * (1 + uint256(c.outOfGasDepth))) {
				revert("Insufficient gas for afterSwap hook");
			}
		}

		return (BaseHook.afterSwap.selector, 0);
	}

	// ──────────────────── Arbitrage + LP share ────────────────────

	function runArbitrage(
		bytes32 poolId,
		bool zeroForOne,
		int128 negAmount0,
		int128 negAmount1,
		address sender
	) external returns (bool failed) {
		require(msg.sender == address(this), "self only");
		IMevxRouter router = mevxRouter;

		(bool successInitialArbCheck, bytes memory returnDataInitialArbCheck) = address(router).call(
			abi.encodeCall(IMevxRouter.initialArbCheck, (poolId, !zeroForOne))
		);
		if (!successInitialArbCheck || returnDataInitialArbCheck.length != 64) return false;

		(bool isArbPossible, bytes16 arbData) = abi.decode(returnDataInitialArbCheck, (bool, bytes16));
		if (!isArbPossible) return false;

		address profitToken;
		address[] memory pools;
		uint256 amountIn;
		bytes memory encodedRoute;
		{
			(bool success, bytes memory returnData) = address(router).call(
				abi.encodeCall(IMevxRouter.constructArbitrageRoute, (poolId, zeroForOne, arbData, negAmount0, negAmount1))
			);
			if (!success || returnData.length < 224) return true;
			(isArbPossible, profitToken, pools, amountIn, encodedRoute) = abi.decode(
				returnData,
				(bool, address, address[], uint256, bytes)
			);
		}
		if (!isArbPossible) return false;

		uint256 balanceBefore = _selfBalance(profitToken);
		try IMevxExecutorWithStatus(address(mevxExecutor)).executeRouteWithStatus(encodedRoute, pools, amountIn, profitToken, address(this)) returns (
			bool executed,
			uint8
		) {
			if (!executed) return true;
		} catch {
			return true;
		}

		uint256 profit = _selfBalance(profitToken) - balanceBefore;
		if (profit == 0) return false;

		uint256 lpAmount = (profit * poolConfig[poolId].lpShareBps) / BPS_DENOMINATOR;
		uint256 donated = lpAmount == 0 ? 0 : _donateToPool(poolId, profitToken, lpAmount);

		uint256 rest = profit - donated;
		if (rest > 0) {
			IProfitDistributor profitDistributor_ = profitDistributor;
			if (profitToken == address(0)) {
				(bool sent, ) = address(profitDistributor_).call{value: rest}("");
				require(sent, "native transfer failed");
			} else {
				IERC20(profitToken).safeTransfer(address(profitDistributor_), rest);
			}
			try profitDistributor_.distributeProfit(poolId, profitToken, sender) {} catch {}
		}

		emit ProfitShared(poolId, profitToken, donated, rest);
	}

	function _donateToPool(bytes32 poolId, address profitToken, uint256 amount) internal returns (uint256) {
		PoolKey memory key = _poolKeys[poolId];
		bool isCurrency0 = Currency.unwrap(key.currency0) == profitToken;
		if (!isCurrency0 && Currency.unwrap(key.currency1) != profitToken) {
			return 0;
		}
		try this.donateAndSettle(key, isCurrency0 ? amount : 0, isCurrency0 ? 0 : amount) {
			return amount;
		} catch {
			return 0;
		}
	}

	function donateAndSettle(PoolKey calldata key, uint256 amount0, uint256 amount1) external {
		require(msg.sender == address(this), "self only");
		poolManager.donate(key, amount0, amount1, "");

		Currency currency = amount0 > 0 ? key.currency0 : key.currency1;
		uint256 amount = amount0 > 0 ? amount0 : amount1;
		if (currency.isAddressZero()) {
			poolManager.settle{value: amount}();
		} else {
			poolManager.sync(currency);
			IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
			require(poolManager.settle() == amount, "settle mismatch");
		}
	}

	function _selfBalance(address token) internal view returns (uint256) {
		return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
	}
}
