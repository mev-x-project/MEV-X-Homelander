// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// Stand-in for the Profit Distributor: keeps what it is sent and records the distributeProfit calls
contract MockProfitDistributor {
	bool public reverts;
	uint256 public calls;
	bytes32 public lastConfigId;
	address public lastToken;
	address public lastSwapRecipient;

	receive() external payable {}

	function setReverts(bool reverts_) external {
		reverts = reverts_;
	}

	function distributeProfit(bytes32 configId, address token, address swapRecipient) external {
		require(!reverts, "distributor failure");
		calls++;
		lastConfigId = configId;
		lastToken = token;
		lastSwapRecipient = swapRecipient;
	}
}
