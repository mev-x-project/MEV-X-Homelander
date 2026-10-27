// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ISingletonHookFactory} from "./interfaces/ISingletonHookFactory.sol";

contract SingletonHookFactory is ISingletonHookFactory, Ownable2Step {
	bytes private _parameters;

	constructor(address owner_) {
		require(owner_ != address(0), "owner is zero address");
		_transferOwnership(owner_);
	}

	function parameters() external view returns (bytes memory) {
		return _parameters;
	}

	function deploy(bytes32 salt, bytes calldata creationCode, bytes calldata params) external onlyOwner returns (address hook) {
		_parameters = params;
		bytes memory code = creationCode;
		assembly {
			hook := create2(0, add(code, 32), mload(code), salt)
		}
		require(hook != address(0), "deploy failed");
		delete _parameters;
		emit HookDeployed(hook, salt, keccak256(creationCode));
	}

	function computeAddress(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
		return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
	}

	function renounceOwnership() public view override onlyOwner {
		revert("renounce disabled");
	}
}
