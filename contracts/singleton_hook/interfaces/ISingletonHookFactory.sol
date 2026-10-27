// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface ISingletonHookFactory {
	event HookDeployed(address indexed hook, bytes32 salt, bytes32 initCodeHash);

	function parameters() external view returns (bytes memory);

	function deploy(bytes32 salt, bytes calldata creationCode, bytes calldata params) external returns (address hook);

	function computeAddress(bytes32 salt, bytes32 initCodeHash) external view returns (address);
}
