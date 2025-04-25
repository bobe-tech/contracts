// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockToken
 * @notice A simple ERC20 token for testing
 */
contract MockToken is ERC20, Ownable {
    uint8 private _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint8 customDecimals,
        address initialOwner
    ) ERC20(name, symbol) Ownable(initialOwner) {
        _decimals = customDecimals;
        _mint(initialOwner, 1000000000 * 10**customDecimals);
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}