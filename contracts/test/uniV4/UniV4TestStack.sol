// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

// PoolManager: compiled for the local test stack
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Settles a caller's deltas with the PoolManager: pays what it owes from `payer`, takes what it is owed
abstract contract UniV4Settlement {
	IPoolManager public immutable manager;

	constructor(IPoolManager manager_) {
		manager = manager_;
	}

	function _settleDeltas(PoolKey memory key, BalanceDelta delta, address payer, address recipient) internal {
		_settle(key.currency0, delta.amount0(), payer, recipient);
		_settle(key.currency1, delta.amount1(), payer, recipient);
	}

	function _settle(Currency currency, int128 amount, address payer, address recipient) private {
		if (amount < 0) {
			uint256 owed = uint256(uint128(-amount));
			if (currency.isAddressZero()) {
				manager.settle{value: owed}();
			} else {
				manager.sync(currency);
				if (payer == address(this)) IERC20(Currency.unwrap(currency)).transfer(address(manager), owed);
				else IERC20(Currency.unwrap(currency)).transferFrom(payer, address(manager), owed);
				manager.settle();
			}
		} else if (amount > 0) {
			manager.take(currency, recipient, uint256(uint128(amount)));
		}
	}
}

/// Test router: liquidity and exact-input swaps paid by msg.sender (native input from msg.value)
contract UniV4TestRouter is UniV4Settlement, IUnlockCallback {
	constructor(IPoolManager manager_) UniV4Settlement(manager_) {}

	receive() external payable {}

	function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external payable {
		manager.unlock(abi.encode(msg.sender, key, true, abi.encode(ModifyLiquidityParams(tickLower, tickUpper, liquidity, 0))));
		_refund();
	}

	function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external payable returns (BalanceDelta delta) {
		SwapParams memory params = SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
		delta = abi.decode(manager.unlock(abi.encode(msg.sender, key, false, abi.encode(params))), (BalanceDelta));
		_refund();
	}

	function unlockCallback(bytes calldata data) external returns (bytes memory) {
		require(msg.sender == address(manager), "not manager");
		(address payer, PoolKey memory key, bool liquidity, bytes memory params) = abi.decode(data, (address, PoolKey, bool, bytes));
		BalanceDelta delta;
		if (liquidity) (delta, ) = manager.modifyLiquidity(key, abi.decode(params, (ModifyLiquidityParams)), "");
		else delta = manager.swap(key, abi.decode(params, (SwapParams)), "");
		_settleDeltas(key, delta, payer, payer);
		return abi.encode(delta);
	}

	function _refund() private {
		if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
	}
}

/// Stand-in for the MEV-X Executor on Uniswap V4. The route is abi.encode(Mode, PoolKey, zeroForOne, profit): swaps
/// amountIn on the pool (inside the user's unlock, as the real executor does) and pays `profit` of profitToken from its
/// own balance to the recipient
contract MockUniV4Executor is UniV4Settlement {
	enum Mode {
		Execute,
		NotExecuted,
		Revert,
		BurnGas
	}

	constructor(IPoolManager manager_) UniV4Settlement(manager_) {}

	receive() external payable {}

	function executeRouteWithStatus(
		bytes calldata encodedRoute,
		address[] memory,
		uint256 amountIn,
		address profitToken,
		address profitRecipient
	) external returns (bool, uint8) {
		(Mode mode, PoolKey memory key, bool zeroForOne, uint256 profit) = abi.decode(encodedRoute, (Mode, PoolKey, bool, uint256));
		if (mode == Mode.NotExecuted) return (false, 7);
		if (mode == Mode.Revert) revert("executor failure");
		if (mode == Mode.BurnGas) {
			uint256 x;
			while (gasleft() > 1000) x = uint256(keccak256(abi.encode(x)));
		}
		if (amountIn > 0) {
			SwapParams memory params = SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1);
			_settleDeltas(key, manager.swap(key, params, ""), address(this), address(this));
		}
		if (profit > 0) {
			if (profitToken == address(0)) payable(profitRecipient).transfer(profit);
			else IERC20(profitToken).transfer(profitRecipient, profit);
		}
		return (true, 0);
	}
}
