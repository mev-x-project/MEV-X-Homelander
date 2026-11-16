// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// Stand-in for the MEV-X Router: answers the hook's calls with values set by the test and records what it was called with
contract MockMevxRouter {
	enum Mode {
		Normal,
		Revert,
		BurnGas
	}

	enum FeeMode {
		None,
		Fixed,
		Revert,
		BurnGas,
		EchoBaseFee,
		EchoMinPlusMax
	}

	Mode public initMode;
	Mode public checkMode;
	Mode public constructMode;
	FeeMode public feeMode;

	bool public arbPossible;
	bytes16 public arbData;
	bool public routePossible = true;
	address public profitToken;
	uint256 public amountIn;
	bytes public route;
	uint24 public dynamicFee;

	uint256 public initCalls;
	bytes32 public lastInitPoolId;
	uint16 public lastInitPoolType;
	bytes public lastInitData;
	uint256 public checkCalls;
	bool public lastCheckZeroToOne;
	uint256 public constructCalls;
	bool public lastConstructZeroToOne;
	bytes16 public lastConstructArbData;
	int256 public lastAmount0;
	int256 public lastAmount1;

	function setModes(Mode init, Mode check, Mode construct) external {
		initMode = init;
		checkMode = check;
		constructMode = construct;
	}

	function setArbitrage(bool possible, bytes16 data, address token, uint256 amount, bytes calldata route_) external {
		arbPossible = possible;
		arbData = data;
		profitToken = token;
		amountIn = amount;
		route = route_;
	}

	function setRoutePossible(bool possible) external {
		routePossible = possible;
	}

	function setDynamicFee(FeeMode mode, uint24 fee) external {
		feeMode = mode;
		dynamicFee = fee;
	}

	function initializePoolExternally(bytes32 poolId, uint16 poolType, bytes memory data) external {
		_apply(initMode);
		initCalls++;
		lastInitPoolId = poolId;
		lastInitPoolType = poolType;
		lastInitData = data;
	}

	function initialArbCheck(bytes32, bool zeroToOne) external returns (bool, bytes16) {
		_apply(checkMode);
		checkCalls++;
		lastCheckZeroToOne = zeroToOne;
		return (arbPossible, arbData);
	}

	function constructArbitrageRoute(
		bytes32,
		bool zeroToOne,
		bytes16 data,
		int256 amount0,
		int256 amount1
	) external returns (bool, address, address[] memory, uint256, bytes memory) {
		_apply(constructMode);
		constructCalls++;
		lastConstructZeroToOne = zeroToOne;
		lastConstructArbData = data;
		lastAmount0 = amount0;
		lastAmount1 = amount1;
		return (routePossible, profitToken, new address[](0), amountIn, route);
	}

	function getDynamicFee(
		bytes32,
		address,
		address,
		bool,
		int256,
		uint24 baseFee,
		uint24 minFee,
		uint24 maxFee
	) external view returns (uint24) {
		FeeMode mode = feeMode;
		if (mode == FeeMode.None) revert();
		if (mode == FeeMode.Revert) revert("no dynamic fee");
		if (mode == FeeMode.BurnGas) _burnGas();
		if (mode == FeeMode.EchoBaseFee) return baseFee;
		if (mode == FeeMode.EchoMinPlusMax) return minFee + maxFee;
		return dynamicFee;
	}

	function _apply(Mode mode) private view {
		if (mode == Mode.Revert) revert("router failure");
		if (mode == Mode.BurnGas) _burnGas();
	}

	function _burnGas() private view {
		uint256 x;
		while (gasleft() > 1000) x = uint256(keccak256(abi.encode(x)));
	}
}
