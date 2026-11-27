// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Token a caller controls: once armed, its transfers from `trigger` revert, burn all gas or call `target` with `data`,
/// or its balanceOf reverts
contract EvilERC20 is ERC20 {
	enum Mode {
		None,
		RevertTransfer,
		BurnGasTransfer,
		RevertBalanceOf,
		CallOnTransfer
	}

	Mode public mode;
	address public trigger;
	address public target;
	bytes public data;

	constructor() ERC20("EVIL", "EVIL") {}

	function mint(address to, uint256 amount) external {
		_mint(to, amount);
	}

	function arm(Mode mode_, address trigger_, address target_, bytes calldata data_) external {
		mode = mode_;
		trigger = trigger_;
		target = target_;
		data = data_;
	}

	function balanceOf(address account) public view override returns (uint256) {
		require(mode != Mode.RevertBalanceOf, "evil balanceOf");
		return super.balanceOf(account);
	}

	function _afterTokenTransfer(address from, address, uint256) internal override {
		if (from != trigger || mode == Mode.None) return;
		if (mode == Mode.RevertTransfer) revert("evil transfer");
		if (mode == Mode.BurnGasTransfer) {
			uint256 x;
			while (true) x = uint256(keccak256(abi.encode(x)));
		}
		if (mode == Mode.CallOnTransfer) {
			Mode m = mode;
			mode = Mode.None;
			(bool ok, bytes memory ret) = target.call(data);
			if (!ok) {
				assembly {
					revert(add(ret, 32), mload(ret))
				}
			}
			mode = m;
		}
	}
}
