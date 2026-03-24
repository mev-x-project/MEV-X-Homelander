// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.5.0 <0.9.0;

/// @title Contains pool type constants
library Constants {
	uint16 internal constant UNISWAP_V2_POOL_TYPE = 0;
	uint16 internal constant UNISWAP_V3_POOL_TYPE = 1;
	uint16 internal constant ALGEBRA_V1_POOL_TYPE = 2;
	uint16 internal constant ALGEBRA_INTEGRAL_POOL_TYPE = 3;
	uint16 internal constant PANCAKE_V3_POOL_TYPE = 4;
	uint16 internal constant UNISWAP_V4_POOL_TYPE = 5;
	uint16 internal constant BALANCER_V2_POOL_TYPE = 6;
	uint16 internal constant FLUID_LITE_POOL_TYPE = 7;
	uint16 internal constant DODO_V2_POOL_TYPE = 8;
	uint16 internal constant WOO_POOL_TYPE = 9;
}
