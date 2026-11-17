// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.19;

import {
	HOOKS_BEFORE_INITIALIZE_OFFSET,
	HOOKS_AFTER_INITIALIZE_OFFSET,
	HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET,
	HOOKS_AFTER_ADD_LIQUIDITY_OFFSET,
	HOOKS_BEFORE_REMOVE_LIQUIDITY_OFFSET,
	HOOKS_AFTER_REMOVE_LIQUIDITY_OFFSET,
	HOOKS_BEFORE_SWAP_OFFSET,
	HOOKS_AFTER_SWAP_OFFSET,
	HOOKS_BEFORE_DONATE_OFFSET,
	HOOKS_AFTER_DONATE_OFFSET,
	HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET,
	HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET,
	HOOKS_AFTER_ADD_LIQUIDIY_RETURNS_DELTA_OFFSET,
	HOOKS_AFTER_REMOVE_LIQUIDIY_RETURNS_DELTA_OFFSET
} from "../infinity-core/pool-cl/interfaces/ICLHooks.sol";
import {PoolKey} from "../infinity-core/types/PoolKey.sol";
import {BalanceDelta} from "../infinity-core/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "../infinity-core/types/BeforeSwapDelta.sol";
import {IHooks} from "../infinity-core/interfaces/IHooks.sol";
import {IVault} from "../infinity-core/interfaces/IVault.sol";
import {ICLHooks} from "../infinity-core/pool-cl/interfaces/ICLHooks.sol";
import {ICLPoolManager} from "../infinity-core/pool-cl/interfaces/ICLPoolManager.sol";
import {CLPoolManager} from "../infinity-core/pool-cl/CLPoolManager.sol";

abstract contract CLBaseHook is ICLHooks {
	error NotPoolManager();
	error NotVault();
	error NotSelf();
	error InvalidPool();
	error LockFailure();
	error HookNotImplemented();

	struct Permissions {
		bool beforeInitialize;
		bool afterInitialize;
		bool beforeAddLiquidity;
		bool afterAddLiquidity;
		bool beforeRemoveLiquidity;
		bool afterRemoveLiquidity;
		bool beforeSwap;
		bool afterSwap;
		bool beforeDonate;
		bool afterDonate;
		bool beforeSwapReturnDelta;
		bool afterSwapReturnDelta;
		bool afterAddLiquidityReturnDelta;
		bool afterRemoveLiquidityReturnDelta;
	}

	ICLPoolManager public immutable poolManager;
	IVault public immutable vault;

	constructor(ICLPoolManager _poolManager) {
		poolManager = _poolManager;
		vault = CLPoolManager(address(poolManager)).vault();
	}

	modifier poolManagerOnly() {
		if (msg.sender != address(poolManager)) revert NotPoolManager();
		_;
	}

	modifier vaultOnly() {
		if (msg.sender != address(vault)) revert NotVault();
		_;
	}

	modifier selfOnly() {
		if (msg.sender != address(this)) revert NotSelf();
		_;
	}

	modifier onlyValidPools(IHooks hooks) {
		if (address(hooks) != address(this)) revert InvalidPool();
		_;
	}

	function lockAcquired(bytes calldata data) external virtual vaultOnly returns (bytes memory) {
		(bool success, bytes memory returnData) = address(this).call(data);
		if (success) return returnData;
		if (returnData.length == 0) revert LockFailure();
		assembly {
			revert(add(returnData, 32), mload(returnData))
		}
	}

	function beforeInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96)
		external
		virtual
		poolManagerOnly
		returns (bytes4)
	{
		return _beforeInitialize(sender, key, sqrtPriceX96);
	}

	function _beforeInitialize(address, PoolKey calldata, uint160) internal virtual returns (bytes4) {
		revert HookNotImplemented();
	}

	function afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
		external
		virtual
		poolManagerOnly
		returns (bytes4)
	{
		return _afterInitialize(sender, key, sqrtPriceX96, tick);
	}

	function _afterInitialize(address, PoolKey calldata, uint160, int24) internal virtual returns (bytes4) {
		revert HookNotImplemented();
	}

	function beforeAddLiquidity(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.ModifyLiquidityParams calldata params,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4) {
		return _beforeAddLiquidity(sender, key, params, hookData);
	}

	function _beforeAddLiquidity(
		address,
		PoolKey calldata,
		ICLPoolManager.ModifyLiquidityParams calldata,
		bytes calldata
	) internal virtual returns (bytes4) {
		revert HookNotImplemented();
	}

	function afterAddLiquidity(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.ModifyLiquidityParams calldata params,
		BalanceDelta delta,
		BalanceDelta feesAccrued,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4, BalanceDelta) {
		return _afterAddLiquidity(sender, key, params, delta, feesAccrued, hookData);
	}

	function _afterAddLiquidity(
		address,
		PoolKey calldata,
		ICLPoolManager.ModifyLiquidityParams calldata,
		BalanceDelta,
		BalanceDelta,
		bytes calldata
	) internal virtual returns (bytes4, BalanceDelta) {
		revert HookNotImplemented();
	}

	function beforeRemoveLiquidity(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.ModifyLiquidityParams calldata params,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4) {
		return _beforeRemoveLiquidity(sender, key, params, hookData);
	}

	function _beforeRemoveLiquidity(
		address,
		PoolKey calldata,
		ICLPoolManager.ModifyLiquidityParams calldata,
		bytes calldata
	) internal virtual returns (bytes4) {
		revert HookNotImplemented();
	}

	function afterRemoveLiquidity(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.ModifyLiquidityParams calldata params,
		BalanceDelta delta,
		BalanceDelta feesAccrued,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4, BalanceDelta) {
		return _afterRemoveLiquidity(sender, key, params, delta, feesAccrued, hookData);
	}

	function _afterRemoveLiquidity(
		address,
		PoolKey calldata,
		ICLPoolManager.ModifyLiquidityParams calldata,
		BalanceDelta,
		BalanceDelta,
		bytes calldata
	) internal virtual returns (bytes4, BalanceDelta) {
		revert HookNotImplemented();
	}

	function beforeSwap(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.SwapParams calldata params,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4, BeforeSwapDelta, uint24) {
		return _beforeSwap(sender, key, params, hookData);
	}

	function _beforeSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, bytes calldata)
		internal
		virtual
		returns (bytes4, BeforeSwapDelta, uint24)
	{
		revert HookNotImplemented();
	}

	function afterSwap(
		address sender,
		PoolKey calldata key,
		ICLPoolManager.SwapParams calldata params,
		BalanceDelta delta,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4, int128) {
		return _afterSwap(sender, key, params, delta, hookData);
	}

	function _afterSwap(address, PoolKey calldata, ICLPoolManager.SwapParams calldata, BalanceDelta, bytes calldata)
		internal
		virtual
		returns (bytes4, int128)
	{
		revert HookNotImplemented();
	}

	function beforeDonate(
		address sender,
		PoolKey calldata key,
		uint256 amount0,
		uint256 amount1,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4) {
		return _beforeDonate(sender, key, amount0, amount1, hookData);
	}

	function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
		internal
		virtual
		returns (bytes4)
	{
		revert HookNotImplemented();
	}

	function afterDonate(
		address sender,
		PoolKey calldata key,
		uint256 amount0,
		uint256 amount1,
		bytes calldata hookData
	) external virtual poolManagerOnly returns (bytes4) {
		return _afterDonate(sender, key, amount0, amount1, hookData);
	}

	function _afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
		internal
		virtual
		returns (bytes4)
	{
		revert HookNotImplemented();
	}

	function _hooksRegistrationBitmapFrom(Permissions memory permissions) internal pure returns (uint16) {
		return uint16(
			(permissions.beforeInitialize ? 1 << HOOKS_BEFORE_INITIALIZE_OFFSET : 0)
				| (permissions.afterInitialize ? 1 << HOOKS_AFTER_INITIALIZE_OFFSET : 0)
				| (permissions.beforeAddLiquidity ? 1 << HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET : 0)
				| (permissions.afterAddLiquidity ? 1 << HOOKS_AFTER_ADD_LIQUIDITY_OFFSET : 0)
				| (permissions.beforeRemoveLiquidity ? 1 << HOOKS_BEFORE_REMOVE_LIQUIDITY_OFFSET : 0)
				| (permissions.afterRemoveLiquidity ? 1 << HOOKS_AFTER_REMOVE_LIQUIDITY_OFFSET : 0)
				| (permissions.beforeSwap ? 1 << HOOKS_BEFORE_SWAP_OFFSET : 0)
				| (permissions.afterSwap ? 1 << HOOKS_AFTER_SWAP_OFFSET : 0)
				| (permissions.beforeDonate ? 1 << HOOKS_BEFORE_DONATE_OFFSET : 0)
				| (permissions.afterDonate ? 1 << HOOKS_AFTER_DONATE_OFFSET : 0)
				| (permissions.beforeSwapReturnDelta ? 1 << HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET : 0)
				| (permissions.afterSwapReturnDelta ? 1 << HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET : 0)
				| (permissions.afterAddLiquidityReturnDelta ? 1 << HOOKS_AFTER_ADD_LIQUIDIY_RETURNS_DELTA_OFFSET : 0)
				| (permissions.afterRemoveLiquidityReturnDelta ? 1 << HOOKS_AFTER_REMOVE_LIQUIDIY_RETURNS_DELTA_OFFSET : 0)
		);
	}
}
