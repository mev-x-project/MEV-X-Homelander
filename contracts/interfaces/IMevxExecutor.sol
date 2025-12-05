// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface IMevxExecutor {
	function executeRoute(
		bytes calldata encodedRoute,
		address[] memory pools,
		uint256 amountIn,
		address profitRecipient
	) external;
}
