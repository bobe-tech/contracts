// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract TokenContract is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant UNLOCK_PERIOD = 30 days;
    uint256 public constant UNLOCK_PERCENTAGE = 10;
    uint256 public constant UNLOCK_PORTIONS = 10;

    uint256 public immutable liquiditySupply;
    uint256 public liquidityLeft;

    uint256 public immutable marketingSupply;
    uint256 public marketingLeft;
    uint256 public immutable marketingUnlockStart;
    uint256 public marketingUnlockedPortions;

    uint256 public immutable teamSupply;
    uint256 public teamLeft;
    uint256 public immutable teamUnlockStart;
    uint256 public teamUnlockedPortions;

    event LiquidityTransferred(address indexed to, uint256 amount);
    event MarketingTransferred(address indexed to, uint256 amount);
    event TeamTransferred(address indexed to, uint256 amount);

    constructor(address multisigAddress) ERC20("Bobe.app", "BOBE") Ownable(multisigAddress) {
        require(multisigAddress != address(0), "Safe multisig address cannot be zero");

        teamUnlockStart = block.timestamp + 548 days;
        marketingUnlockStart = block.timestamp;

        uint256 totalSupply = 1_000_000_000 * 10 ** 18;
        liquiditySupply = (totalSupply * 80) / 100;
        marketingSupply = (totalSupply * 12) / 100;
        teamSupply = totalSupply - (liquiditySupply + marketingSupply);

        liquidityLeft = liquiditySupply;
        marketingLeft = marketingSupply;
        teamLeft = teamSupply;

        marketingUnlockedPortions = 0;
        teamUnlockedPortions = 0;

        _mint(address(this), totalSupply);
    }

    function transferLiquidity(address to, uint256 value) external onlyOwner {
        liquidityLeft = _transferTokens(to, value, liquidityLeft);
        emit LiquidityTransferred(to, value);
    }

    function _transferUnlockedTokens(
        address to,
        uint256 value,
        uint256 unlockedAmount,
        uint256 totalSupply,
        uint256 tokensLeft,
        string memory errorMessage
    ) private returns (uint256) {
        uint256 alreadyWithdrawn = totalSupply - tokensLeft;
        uint256 availableToWithdraw = unlockedAmount - alreadyWithdrawn;

        require(value <= availableToWithdraw, errorMessage);

        return _transferTokens(to, value, tokensLeft);
    }

    function transferMarketing(address to, uint256 value) external onlyOwner {
        marketingLeft = _transferUnlockedTokens(
            to,
            value,
            getUnlockedMarketingAmount(),
            marketingSupply,
            marketingLeft,
            "Amount exceeds currently unlocked marketing tokens"
        );

        emit MarketingTransferred(to, value);
    }

    function transferTeam(address to, uint256 value) external onlyOwner {
        require(block.timestamp >= teamUnlockStart, "Team tokens are still in initial lock period");

        teamLeft = _transferUnlockedTokens(to, value, getUnlockedTeamAmount(), teamSupply, teamLeft, "Amount exceeds currently unlocked team tokens");

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

    function _getUnlockedAmount(uint256 totalSupply, uint256 unlockStart) private view returns (uint256) {
        if (block.timestamp < unlockStart) {
            return 0;
        }

        uint256 elapsedPeriods = (block.timestamp - unlockStart) / UNLOCK_PERIOD;
        if (elapsedPeriods >= UNLOCK_PORTIONS) {
            return totalSupply;
        }

        return (totalSupply * elapsedPeriods * UNLOCK_PERCENTAGE) / 100;
    }

    function _getNextUnlock(uint256 totalSupply, uint256 unlockStart) private view returns (uint256 nextAmount, uint256 nextTimestamp) {
        if (block.timestamp < unlockStart) {
            return ((totalSupply * UNLOCK_PERCENTAGE) / 100, unlockStart);
        }

        uint256 elapsedPeriods = (block.timestamp - unlockStart) / UNLOCK_PERIOD;
        if (elapsedPeriods >= UNLOCK_PORTIONS) {
            return (0, 0);
        }

        uint256 nextPeriod = elapsedPeriods + 1;
        uint256 nextUnlockTimestamp = unlockStart + (nextPeriod * UNLOCK_PERIOD);
        uint256 nextTotalUnlocked = (totalSupply * nextPeriod * UNLOCK_PERCENTAGE) / 100;
        uint256 currentlyUnlocked = (totalSupply * elapsedPeriods * UNLOCK_PERCENTAGE) / 100;

        return (nextTotalUnlocked - currentlyUnlocked, nextUnlockTimestamp);
    }

    function getUnlockedMarketingAmount() public view returns (uint256) {
        return _getUnlockedAmount(marketingSupply, marketingUnlockStart);
    }

    function getUnlockedTeamAmount() public view returns (uint256) {
        return _getUnlockedAmount(teamSupply, teamUnlockStart);
    }

    function getNextMarketingUnlock() public view returns (uint256 nextAmount, uint256 nextTimestamp) {
        return _getNextUnlock(marketingSupply, marketingUnlockStart);
    }

    function getNextTeamUnlock() public view returns (uint256 nextAmount, uint256 nextTimestamp) {
        return _getNextUnlock(teamSupply, teamUnlockStart);
    }

    function teamUnlockIn() external view returns (uint256) {
        if (block.timestamp >= teamUnlockStart) return 0;
        return teamUnlockStart - block.timestamp;
    }

    function _getTokenUnlockInfo(
        uint256 tokenSupply,
        uint256 tokensLeft,
        uint256 unlockStart
    ) private view returns (uint256 totalUnlocked, uint256 availableToWithdraw, uint256 nextUnlockAmount, uint256 nextUnlockTime) {
        totalUnlocked = _getUnlockedAmount(tokenSupply, unlockStart);
        uint256 alreadyWithdrawn = tokenSupply - tokensLeft;
        availableToWithdraw = totalUnlocked > alreadyWithdrawn ? totalUnlocked - alreadyWithdrawn : 0;

        (nextUnlockAmount, nextUnlockTime) = _getNextUnlock(tokenSupply, unlockStart);

        return (totalUnlocked, availableToWithdraw, nextUnlockAmount, nextUnlockTime);
    }

    function getUnlockStatus()
        external
        view
        returns (
            uint256 marketingTotalUnlocked,
            uint256 marketingAvailableToWithdraw,
            uint256 marketingNextUnlockAmount,
            uint256 marketingNextUnlockTime,
            uint256 teamTotalUnlocked,
            uint256 teamAvailableToWithdraw,
            uint256 teamNextUnlockAmount,
            uint256 teamNextUnlockTime
        )
    {
        (marketingTotalUnlocked, marketingAvailableToWithdraw, marketingNextUnlockAmount, marketingNextUnlockTime) = _getTokenUnlockInfo(
            marketingSupply,
            marketingLeft,
            marketingUnlockStart
        );

        (teamTotalUnlocked, teamAvailableToWithdraw, teamNextUnlockAmount, teamNextUnlockTime) = _getTokenUnlockInfo(
            teamSupply,
            teamLeft,
            teamUnlockStart
        );

        return (
            marketingTotalUnlocked,
            marketingAvailableToWithdraw,
            marketingNextUnlockAmount,
            marketingNextUnlockTime,
            teamTotalUnlocked,
            teamAvailableToWithdraw,
            teamNextUnlockAmount,
            teamNextUnlockTime
        );
    }

    function _transferTokens(address to, uint256 value, uint256 availableAmount) internal returns (uint256) {
        require(to != address(0), "Invalid address");
        require(value > 0, "Value must be greater than 0");
        require(value <= availableAmount, "Not enough tokens to transfer");
        require(balanceOf(address(this)) >= value, "Insufficient balance");

        uint256 remainingAmount = availableAmount - value;
        _transfer(address(this), to, value);

        return remainingAmount;
    }
}
