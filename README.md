# Smart Contracts for Audit

This repository contains three main smart contracts for the Bobe.app ecosystem. Below you'll find detailed information about each contract and its functionality.

## Overview

The project consists of three main contracts:
- TokenContract (BOBE token)
- SwapContract (Token purchase contract)
- StakingContract (Staking mechanism)

## Development Environment

- Solidity version: 0.8.24
- Framework: Hardhat
- Network: BNB Chain (BSC)
- Dependencies:
  - OpenZeppelin Contracts
  - Chainlink Price Feeds

## Installation and Setup

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile
```

## Testing

The project includes comprehensive test suites for all contracts:

```bash
# Run all tests
npx hardhat test

# Run tests for a specific contract
npx hardhat test test/TokenContract.test.js
npx hardhat test test/SwapContract.test.js
npx hardhat test test/StakingContract.test.js

# Run tests with gas reporting
REPORT_GAS=true npx hardhat test
```

## Contracts Description

### 1. TokenContract (Bobe.app Token)

An ERC20 token with additional distribution and vesting mechanics.

**Token Details:**
- Name: Bobe.app
- Symbol: BOBE
- Total Supply: 1,000,000,000 (1 billion)
- Decimals: 18

**Token Distribution:**
- Liquidity Pool: 80%
- Marketing: 12%
- Team: 8% (locked for 548 days)

**Key Functions:**
- `transferLiquidity`: Transfers tokens from liquidity allocation
- `transferMarketing`: Transfers tokens from marketing allocation
- `transferTeam`: Transfers tokens from team allocation (time-locked)
- `recoverTokens`: Allows recovery of tokens sent to the contract accidentally
- `teamUnlockIn`: Shows remaining time until team tokens unlock

### 2. SwapContract (Token Purchase)

A contract for purchasing the main token using various payment methods.

**Key Features:**
- Multiple payment token support (USDT, FDUSD, DAI, USDC)
- Native BNB payments support
- Dynamic price feed integration using Chainlink
- Custom token swap support through PancakeSwap Router

**Main Functions:**
- `swapNativeToken`: Purchase tokens with BNB
- `swapStableTokens`: Purchase tokens with supported stablecoins
- `swapAnyTokens`: Purchase tokens with any token through PancakeSwap Router
- `setPrice`: Update token price (admin only)
- `allowStableTokens`: Add new supported stablecoins
- `disallowStableToken`: Remove stablecoin support

### 3. StakingContract (Staking Mechanism)

A staking contract with reward distribution mechanics.

**Key Features:**
- Flexible campaign duration
- Custom unstake period (default: 365 days)
- Dynamic reward calculation
- Multiple staking positions per user

**Main Functions:**
- `stake`: Stake tokens
- `unstake`: Withdraw staked tokens after lock period
- `claimRewards`: Claim accumulated rewards
- `announce`: Start new staking campaign
- `depositAndAnnounce`: Combine deposit and campaign announcement
- `getUserStats`: Get detailed user staking information
- `getGlobalStats`: Get global staking statistics
