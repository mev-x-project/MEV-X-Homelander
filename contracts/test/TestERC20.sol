// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract TestERC20 is ERC20 {
	constructor(string memory symbol) ERC20(symbol, symbol) {}

	function mint(address to, uint256 amount) external {
		_mint(to, amount);
	}
}
