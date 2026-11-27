// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

// Vault and CLPoolManager: compiled for the local test stack
import {Vault} from "infinity-core/src/Vault.sol";
import {CLPoolManager} from "infinity-core/src/pool-cl/CLPoolManager.sol";
import {IVault} from "infinity-core/src/interfaces/IVault.sol";
import {ILockCallback} from "infinity-core/src/interfaces/ILockCallback.sol";
import {ICLPoolManager} from "infinity-core/src/pool-cl/interfaces/ICLPoolManager.sol";
import {PoolKey} from "infinity-core/src/types/PoolKey.sol";
import {Currency} from "infinity-core/src/types/Currency.sol";
import {BalanceDelta} from "infinity-core/src/types/BalanceDelta.sol";
import {TickMath} from "infinity-core/src/pool-cl/libraries/TickMath.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Settles a caller's deltas with the Vault: pays what it owes from `payer`, takes what it is owed
abstract contract PancakeSettlement {
	IVault public immutable vault;
	ICLPoolManager public immutable manager;

	constructor(IVault vault_, ICLPoolManager manager_) {
		vault = vault_;
		manager = manager_;
	}

	function _settleDeltas(PoolKey memory key, BalanceDelta delta, address payer, address recipient) internal {
		_settle(key.currency0, delta.amount0(), payer, recipient);
		_settle(key.currency1, delta.amount1(), payer, recipient);
	}

	function _settle(Currency currency, int128 amount, address payer, address recipient) private {
		if (amount < 0) {
			uint256 owed = uint256(uint128(-amount));
			if (currency.isNative()) {
				vault.settle{value: owed}();
			} else {
				vault.sync(currency);
				if (payer == address(this)) IERC20(Currency.unwrap(currency)).transfer(address(vault), owed);
				else IERC20(Currency.unwrap(currency)).transferFrom(payer, address(vault), owed);
				vault.settle();
			}
		} else if (amount > 0) {
			vault.take(currency, recipient, uint256(uint128(amount)));
		}
	}
}

/// Test router: liquidity and exact-input swaps paid by msg.sender (native input from msg.value)
contract PancakeTestRouter is PancakeSettlement, ILockCallback {
	constructor(IVault vault_, ICLPoolManager manager_) PancakeSettlement(vault_, manager_) {}

	receive() external payable {}

	function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external payable {
		vault.lock(abi.encode(msg.sender, key, true, abi.encode(ICLPoolManager.ModifyLiquidityParams(tickLower, tickUpper, liquidity, 0))));
		_refund();
	}

	function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external payable returns (BalanceDelta delta) {
		ICLPoolManager.SwapParams memory params = ICLPoolManager.SwapParams(
			zeroForOne,
			-int256(amountIn),
			zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
		);
		delta = abi.decode(vault.lock(abi.encode(msg.sender, key, false, abi.encode(params))), (BalanceDelta));
		_refund();
	}

	function lockAcquired(bytes calldata data) external returns (bytes memory) {
		require(msg.sender == address(vault), "not vault");
		(address payer, PoolKey memory key, bool liquidity, bytes memory params) = abi.decode(data, (address, PoolKey, bool, bytes));
		BalanceDelta delta;
		if (liquidity) (delta, ) = manager.modifyLiquidity(key, abi.decode(params, (ICLPoolManager.ModifyLiquidityParams)), "");
		else delta = manager.swap(key, abi.decode(params, (ICLPoolManager.SwapParams)), "");
		_settleDeltas(key, delta, payer, payer);
		return abi.encode(delta);
	}

	function _refund() private {
		if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
	}
}

/// Stand-in for the MEV-X Executor on PancakeSwap Infinity. The route is abi.encode(Mode, PoolKey, zeroForOne, profit):
/// swaps amountIn on the pool (inside the user's lock, as the real executor does) and pays `profit` of profitToken from
/// its own balance to the recipient
contract MockPancakeExecutor is PancakeSettlement {
	enum Mode {
		Execute,
		NotExecuted,
		Revert,
		BurnGas
	}

	constructor(IVault vault_, ICLPoolManager manager_) PancakeSettlement(vault_, manager_) {}

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
		// the real executor settles first in every V4 / Infinity step, which consumes a sync the caller left pending
		try vault.settle() {} catch {}
		if (amountIn > 0) {
			ICLPoolManager.SwapParams memory params = ICLPoolManager.SwapParams(
				zeroForOne,
				-int256(amountIn),
				zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
			);
			_settleDeltas(key, manager.swap(key, params, ""), address(this), address(this));
		}
		if (profit > 0) {
			if (profitToken == address(0)) payable(profitRecipient).transfer(profit);
			else IERC20(profitToken).transfer(profitRecipient, profit);
		}
		return (true, 0);
	}
}

/// Router that keeps a currency synced across its swaps (see UniV4SyncHoldingRouter)
contract PancakeSyncHoldingRouter is ILockCallback {
	IVault public immutable vault;
	ICLPoolManager public immutable manager;

	struct Order {
		PoolKey[] keys;
		bool zeroForOne;
		uint256 amountIn;
		bool payBefore;
		uint256 extra;
		address hold;
	}

	constructor(IVault vault_, ICLPoolManager manager_) {
		vault = vault_;
		manager = manager_;
	}

	receive() external payable {}

	function swap(Order calldata order) external payable {
		vault.lock(abi.encode(msg.sender, order));
		if (address(this).balance > 0) payable(msg.sender).transfer(address(this).balance);
	}

	function lockAcquired(bytes calldata data) external returns (bytes memory) {
		require(msg.sender == address(vault), "not vault");
		(address payer, Order memory o) = abi.decode(data, (address, Order));
		Currency input = o.zeroForOne ? o.keys[0].currency0 : o.keys[0].currency1;
		uint256 total = o.amountIn * o.keys.length;
		Currency hold = o.hold == address(0) ? input : Currency.wrap(o.hold);
		uint256 owed = o.extra;
		if (Currency.unwrap(hold) == Currency.unwrap(input)) owed += total;
		else _payNow(input, payer, total);

		vault.sync(hold);
		if (o.payBefore) _transfer(hold, payer, owed);
		for (uint256 i; i < o.keys.length; i++) {
			ICLPoolManager.SwapParams memory params = ICLPoolManager.SwapParams(
				o.zeroForOne,
				-int256(o.amountIn),
				o.zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1
			);
			BalanceDelta delta = manager.swap(o.keys[i], params, "");
			int128 out = o.zeroForOne ? delta.amount1() : delta.amount0();
			vault.take(o.zeroForOne ? o.keys[i].currency1 : o.keys[i].currency0, payer, uint256(uint128(out)));
		}
		if (!o.payBefore) _transfer(hold, payer, owed);
		uint256 paid = hold.isNative() ? vault.settle{value: owed}() : vault.settle();
		require(paid == owed, "credited a different amount");
		if (o.extra != 0) vault.take(hold, payer, o.extra);
		return "";
	}

	function _payNow(Currency currency, address payer, uint256 amount) private {
		vault.sync(currency);
		_transfer(currency, payer, amount);
		if (currency.isNative()) vault.settle{value: amount}();
		else vault.settle();
	}

	function _transfer(Currency currency, address payer, uint256 amount) private {
		if (!currency.isNative()) IERC20(Currency.unwrap(currency)).transferFrom(payer, address(vault), amount);
	}
}
