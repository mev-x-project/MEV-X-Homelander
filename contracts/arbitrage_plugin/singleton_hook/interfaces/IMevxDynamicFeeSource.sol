// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface IMevxDynamicFeeSource {
	function getDynamicFee(
		bytes32 poolId,
		address sender,
		address origin,
		bool zeroForOne,
		int256 amountSpecified,
		uint24 baseFee,
		uint24 minFee,
		uint24 maxFee
	) external view returns (uint24 fee);
}
