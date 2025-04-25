// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../SwapContract.sol";

/**
 * @title ReentrancyAttackReceiver
 * @notice A contract that attempts reentrancy attacks when receiving ETH
 */
contract ReentrancyAttackReceiver is Ownable {
    SwapContract public swapContract;
    address public stableToken;
    bool public isAttacking;
    uint256 public attackAmount;

    constructor(
        address initialOwner,
        address _swapContract,
        address _stableToken
    ) Ownable(initialOwner) {
        swapContract = SwapContract(_swapContract);
        stableToken = _stableToken;
        isAttacking = false;
    }
    
    function setAttackAmount(uint256 _amount) external onlyOwner {
        attackAmount = _amount;
    }
    
    function enableAttack() external onlyOwner {
        isAttacking = true;
    }
    
    function disableAttack() external onlyOwner {
        isAttacking = false;
    }

    // This receive function is called when the contract receives ETH
    receive() external payable {
        if (isAttacking) {
            // Attempt to call swapStableTokens during ETH reception
            // This should fail if the nonReentrant modifier is working correctly
            performReentrancyAttack();
        }
    }
    
    function performReentrancyAttack() internal {
        // Temporarily disable attacking to prevent infinite recursion
        isAttacking = false;
        
        // Approve token spending by the swap contract
        IERC20(stableToken).approve(address(swapContract), attackAmount);
        
        // Try to call swapStableTokens during ETH transfer to attempt reentrancy
        try swapContract.swapStableTokens(stableToken, attackAmount) {
            // If this succeeds, the reentrancy protection failed
        } catch {
            // Expected to catch an error if reentrancy protection works
        }
        
        // Re-enable attack for future calls
        isAttacking = true;
    }
}