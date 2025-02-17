// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract TokenContract is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 public immutable liquiditySupply;
    uint256 public liquidityLeft;

    uint256 public immutable marketingSupply;
    uint256 public marketingLeft;

    uint256 public immutable teamSupply;
    uint256 public teamLeft;
    uint256 public immutable teamUnlockTime;

    event LiquidityTransferred(address indexed to, uint256 amount);
    event MarketingTransferred(address indexed to, uint256 amount);
    event TeamTransferred(address indexed to, uint256 amount);

    constructor() ERC20("Bobe.app", "BOBE") Ownable(_msgSender()) {
        teamUnlockTime = block.timestamp + 548 days;

        uint256 totalSupply = 1_000_000_000 * 10 ** 18;
        liquiditySupply = (totalSupply * 80) / 100;
        marketingSupply = (totalSupply * 12) / 100;
        teamSupply = totalSupply - (liquiditySupply + marketingSupply);

        liquidityLeft = liquiditySupply;
        marketingLeft = marketingSupply;
        teamLeft = teamSupply;

        _mint(address(this), totalSupply);
    }

    function transferLiquidity(address to, uint256 value) external onlyOwner {
        require(to != address(0), "Invalid address");
        require(value > 0, "Value must be greater than 0");
        require(value <= liquidityLeft, "Not enough tokens to transfer");
        require(balanceOf(address(this)) > 0, "No tokens to transfer");

        liquidityLeft -= value;

        _transfer(address(this), to, value);

        emit LiquidityTransferred(to, value);
    }

    function transferMarketing(address to, uint256 value) external onlyOwner {
        require(to != address(0), "Invalid address");
        require(value > 0, "Value must be greater than 0");
        require(value <= marketingLeft, "Not enough tokens to transfer");
        require(balanceOf(address(this)) > 0, "No tokens to transfer");

        marketingLeft -= value;

        _transfer(address(this), to, value);

        emit MarketingTransferred(to, value);
    }

    function transferTeam(address to, uint256 value) external onlyOwner {
        require(block.timestamp >= teamUnlockTime, "Tokens are still locked");
        require(to != address(0), "Invalid address");
        require(value > 0, "Value must be greater than 0");
        require(value <= teamLeft, "Not enough tokens to transfer");
        require(balanceOf(address(this)) > 0, "No tokens to transfer");

        teamLeft -= value;

        _transfer(address(this), to, value);

        emit TeamTransferred(to, value);
    }

    function recoverTokens(IERC20 token) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to recover");

        if (address(token) == address(this)) {
            uint256 totalLeft = teamLeft + marketingLeft + liquidityLeft;
            require(balance > totalLeft, "All tokens are locked");

            uint256 excessBalance = balance - totalLeft;
            token.safeTransfer(owner(), excessBalance);
        } else {
            token.safeTransfer(owner(), balance);
        }
    }

    function teamUnlockIn() external view returns (uint256) {
        if (block.timestamp >= teamUnlockTime) return 0;
        return teamUnlockTime - block.timestamp;
    }
}
