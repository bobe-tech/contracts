// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// This is a simplified mock PancakeSwap router for testing
contract MockPancakeRouter {
    using SafeERC20 for IERC20;
    
    // USDT address used for routes
    address public usdtAddress;
    
    // Exchange rates for token pairs (token0 => token1 => rate)
    // Rate is multiplied by 1e18 for precision
    mapping(address => mapping(address => uint256)) public exchangeRates;
    
    constructor(address _usdtAddress) {
        usdtAddress = _usdtAddress;
    }
    
    // Set exchange rate between two tokens (1 token0 = rate * token1)
    function setExchangeRate(address token0, address token1, uint256 rate) external {
        exchangeRates[token0][token1] = rate * 1e18;
    }
    
    // Get amount out for specific route
    function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts) {
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        
        for (uint i = 0; i < path.length - 1; i++) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            
            uint256 rate = exchangeRates[tokenIn][tokenOut];
            if (rate == 0) {
                rate = 1e18; // Default 1:1 rate if not set
            }
            
            amounts[i + 1] = (amounts[i] * rate) / 1e18;
        }
        
        return amounts;
    }
    
    // Swap exact tokens for tokens
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to
    ) external payable returns (uint256 amountOut) {
        require(path.length >= 2, "Path too short");
        
        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];
        
        // Get amount out
        uint256[] memory amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        
        for (uint i = 0; i < path.length - 1; i++) {
            address currentTokenIn = path[i];
            address currentTokenOut = path[i + 1];
            
            uint256 rate = exchangeRates[currentTokenIn][currentTokenOut];
            if (rate == 0) {
                rate = 1e18; // Default 1:1 rate
            }
            
            amounts[i + 1] = (amounts[i] * rate) / 1e18;
        }
        
        amountOut = amounts[path.length - 1];
        require(amountOut >= amountOutMin, "Insufficient output amount");
        
        // Transfer tokens (user already transferred tokenIn to the contract in SwapContract)
        // Transfer tokenOut to recipient
        IERC20(tokenOut).safeTransfer(to, amountOut);
        
        return amountOut;
    }
}