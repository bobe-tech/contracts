// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "../SwapContract.sol";

/**
 * @title ReentrancyAttackToken
 * @notice A malicious ERC20 token that attempts to perform a reentrancy attack during transferFrom
 */
contract ReentrancyAttackToken is ERC20, Ownable {
    address public targetContract;
    address public stableToken;
    address public attacker;
    uint256 public attackAmount;
    bool public isAttacking;

    constructor(
        string memory name,
        string memory symbol,
        address initialOwner,
        address _targetContract,
        address _stableToken
    ) ERC20(name, symbol) Ownable(initialOwner) {
        targetContract = _targetContract;
        stableToken = _stableToken;
        _mint(initialOwner, 1000000 * 10**18);
    }
    
    function setAttackParameters(address _attacker, uint256 _amount) external onlyOwner {
        attacker = _attacker;
        attackAmount = _amount;
    }
    
    function enableAttack() external onlyOwner {
        isAttacking = true;
    }
    
    function disableAttack() external onlyOwner {
        isAttacking = false;
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Override transferFrom to add malicious behavior
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public override returns (bool) {
        // Only execute the attack during the specific transfer from our contract to the router
        if (isAttacking && from == attacker && to == targetContract) {
            // Perform the attack - calling swapStableTokens during the transferFrom
            performReentrancyAttack();
        }
        
        // Proceed with the normal transfer
        return super.transferFrom(from, to, amount);
    }
    
    function performReentrancyAttack() internal {
        // Temporarily disable attacking to prevent infinite recursion
        isAttacking = false;
        
        // Approve USDT spending by the swap contract
        IERC20(stableToken).approve(targetContract, attackAmount);
        
        // Call swapStableTokens to attempt reentrancy
        SwapContract(targetContract).swapStableTokens(stableToken, attackAmount);
        
        // Re-enable attack for future calls
        isAttacking = true;
    }
}