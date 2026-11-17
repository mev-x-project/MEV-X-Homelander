// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface IMevxExecutorWithStatus {
	function executeRouteWithStatus(
		bytes calldata encodedRoute,
		address[] memory pools,
		uint256 amountIn,
		address profitToken,
		address profitRecipient
	) external returns (bool success, uint8 failReason);
}
