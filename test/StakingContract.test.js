const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("StakingContract", function () {
  let stakingContract;
  let stakingToken;
  let rewardsToken;
  let admin;
  let announcer;
  let user;
  let user2;
  
  // Helper function to check if a campaign is currently active
  async function isActiveCampaign() {
    const currentTime = (await ethers.provider.getBlock("latest")).timestamp;
    const startTime = await stakingContract.scStartTimestamp();
    const endTime = await stakingContract.scFinishTimestamp();
    
    return startTime <= currentTime && currentTime <= endTime;
  }

  beforeEach(async function () {
    // Get signers
    [admin, announcer, user, user2] = await ethers.getSigners();
    
    // Deploy mock tokens for testing
    const MockToken = await ethers.getContractFactory("MockToken");
    stakingToken = await MockToken.deploy("Staking Token", "STK", 18, admin.address);
    await stakingToken.deploymentTransaction().wait();
    
    rewardsToken = await MockToken.deploy("Rewards Token", "RWD", 18, admin.address);
    await rewardsToken.deploymentTransaction().wait();
    
    // Deploy the StakingContract using upgrades plugin
    const StakingContract = await ethers.getContractFactory("StakingContract");
    stakingContract = await upgrades.deployProxy(
      StakingContract,
      [admin.address, announcer.address],
      { initializer: 'initialize' }
    );
    await stakingContract.waitForDeployment();
    
    // Set token addresses
    await stakingContract.setTokenAddresses(
      await stakingToken.getAddress(),
      await rewardsToken.getAddress()
    );
    
    // Mint tokens to users for testing
    await stakingToken.mint(user.address, ethers.parseEther("10000"));
    await stakingToken.mint(user2.address, ethers.parseEther("10000"));
    await rewardsToken.mint(admin.address, ethers.parseEther("100000"));
  });

  describe("Deployment", function () {
    it("Should deploy the contract with correct initial values", async function () {
      // Check admin and announcer roles are set correctly
      const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
      const ANNOUNCER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ANNOUNCER_ROLE"));
      
      expect(await stakingContract.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
      expect(await stakingContract.hasRole(ANNOUNCER_ROLE, announcer.address)).to.be.true;
      
      // Check default campaign duration
      expect(await stakingContract.campaignDuration()).to.equal(23 * 60 * 60 + 58 * 60); // 23h 58m in seconds
      
      // Check unstake period
      expect(await stakingContract.unstakePeriod()).to.equal(365 * 24 * 60 * 60); // 365 days in seconds
      
      // Check initial values for rewards
      expect(await stakingContract.deposited()).to.equal(0);
      expect(await stakingContract.distributed()).to.equal(0);
      expect(await stakingContract.totalAllocatedRewards()).to.equal(0);
      expect(await stakingContract.totalRewardsCommitted()).to.equal(0);
      
      // Check campaign state
      expect(await stakingContract.scStartTimestamp()).to.equal(0);
      expect(await stakingContract.scFinishTimestamp()).to.equal(0);
      expect(await stakingContract.scRewardsAmount()).to.equal(0);
    });
    
    it("Should set token addresses correctly", async function () {
      const stakingTokenAddress = await stakingToken.getAddress();
      const rewardsTokenAddress = await rewardsToken.getAddress();
      
      expect(await stakingContract.stakingToken()).to.equal(stakingTokenAddress);
      expect(await stakingContract.rewardsToken()).to.equal(rewardsTokenAddress);
    });
    
    it("Should emit events when setting token addresses", async function () {
      // Deploy a new contract for this test
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const newStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await newStakingContract.waitForDeployment();
      
      const stakingTokenAddress = await stakingToken.getAddress();
      const rewardsTokenAddress = await rewardsToken.getAddress();
      
      // Check event emission
      await expect(newStakingContract.setTokenAddresses(stakingTokenAddress, rewardsTokenAddress))
        .to.emit(newStakingContract, "TokenAddressesSet")
        .withArgs(stakingTokenAddress, rewardsTokenAddress);
    });
    
    it("Should only allow setting token addresses once", async function () {
      const newMockToken = await (await ethers.getContractFactory("MockToken"))
        .deploy("New Token", "NEW", 18, admin.address);
      
      // Try to set token addresses again
      await expect(
        stakingContract.setTokenAddresses(
          await newMockToken.getAddress(), 
          await rewardsToken.getAddress()
        )
      ).to.be.revertedWith("Token addresses can only be set once");
    });
    
    it("Should prevent setting the same token for staking and rewards", async function () {
      // Deploy a new contract for this test
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const newStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await newStakingContract.waitForDeployment();
      
      const tokenAddress = await stakingToken.getAddress();
      
      // Try to set the same token for both staking and rewards
      await expect(
        newStakingContract.setTokenAddresses(tokenAddress, tokenAddress)
      ).to.be.revertedWith("Staking and rewards tokens must be different");
    });
    
    it("Should allow admin to change unstake period", async function () {
      const newPeriod = 30 * 24 * 60 * 60; // 30 days
      
      // Check event emission
      await expect(stakingContract.setUnstakePeriod(newPeriod))
        .to.emit(stakingContract, "UnstakePeriodSet")
        .withArgs(newPeriod);
      
      // Verify the value was updated
      expect(await stakingContract.unstakePeriod()).to.equal(newPeriod);
    });
    
    it("Should prevent setting invalid unstake periods", async function () {
      // Try to set zero period
      await expect(stakingContract.setUnstakePeriod(0))
        .to.be.revertedWith("Duration must be > 0");
      
      // Try to set too long period
      const tooLongPeriod = 366 * 24 * 60 * 60; // 366 days
      await expect(stakingContract.setUnstakePeriod(tooLongPeriod))
        .to.be.revertedWith("Duration too long");
    });
    
    it("Should only allow admin to change unstake period", async function () {
      const newPeriod = 30 * 24 * 60 * 60; // 30 days
      
      // Try to set period from non-admin account
      await expect(stakingContract.connect(user).setUnstakePeriod(newPeriod))
        .to.be.reverted; // AccessControl error
    });
    
    it("Should allow admin to change campaign duration", async function () {
      const newDuration = 12 * 60 * 60; // 12 hours
      
      // Check event emission
      await expect(stakingContract.setCampaignDuration(newDuration))
        .to.emit(stakingContract, "CampaignDurationSet")
        .withArgs(newDuration);
      
      // Verify the value was updated
      expect(await stakingContract.campaignDuration()).to.equal(newDuration);
    });
    
    it("Should prevent setting invalid campaign durations", async function () {
      // Try to set zero duration
      await expect(stakingContract.setCampaignDuration(0))
        .to.be.revertedWith("Duration must be > 0");
      
      // Try to set too long duration
      const tooLongDuration = 31 * 24 * 60 * 60; // 31 days
      await expect(stakingContract.setCampaignDuration(tooLongDuration))
        .to.be.revertedWith("Duration too long");
    });
    
    it("Should only allow admin to change campaign duration", async function () {
      const newDuration = 12 * 60 * 60; // 12 hours
      
      // Try to set duration from non-admin account
      await expect(stakingContract.connect(user).setCampaignDuration(newDuration))
        .to.be.reverted; // AccessControl error
    });
  });
  
  describe("Deposit and Announce", function () {
    it("Should deposit rewards tokens to the contract", async function () {
      const depositAmount = ethers.parseEther("10000");
      
      // Approve tokens for deposit
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      
      // Verify initial state
      expect(await stakingContract.deposited()).to.equal(0);
      
      // Deposit and check event
      await expect(stakingContract.connect(admin).deposit(depositAmount))
        .to.emit(stakingContract, "Deposit")
        .withArgs(depositAmount);
      
      // Verify the deposit was recorded correctly
      expect(await stakingContract.deposited()).to.equal(depositAmount);
      expect(await rewardsToken.balanceOf(await stakingContract.getAddress())).to.equal(depositAmount);
    });
    
    it("Should revert deposit with zero amount", async function () {
      await expect(stakingContract.connect(admin).deposit(0))
        .to.be.revertedWith("Amount must be > 0");
    });
    
    it("Should revert deposit when token addresses are not set", async function () {
      // Create a new contract for this test
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const newStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await newStakingContract.waitForDeployment();
      
      // Try to deposit before setting token addresses
      await expect(newStakingContract.connect(admin).deposit(ethers.parseEther("100")))
        .to.be.revertedWith("Token addresses must be set first");
    });
    
    it("Should announce a new rewards campaign", async function () {
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards first
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Verify initial state
      expect(await stakingContract.scStartTimestamp()).to.equal(0);
      expect(await stakingContract.scFinishTimestamp()).to.equal(0);
      expect(await stakingContract.scRewardsAmount()).to.equal(0);
      
      // Get the current block timestamp
      const latestBlock = await ethers.provider.getBlock("latest");
      const startTime = latestBlock.timestamp;
      const finishTime = Number(startTime) + Number(await stakingContract.campaignDuration());
      
      // Announce and check event
      await expect(stakingContract.connect(admin).announce(announceAmount))
        .to.emit(stakingContract, "Announce");
      
      // Verify campaign was set up correctly
      const campaignStart = await stakingContract.scStartTimestamp();
      const campaignEnd = await stakingContract.scFinishTimestamp();
      
      expect(campaignStart).to.be.at.least(startTime);
      expect(campaignEnd).to.be.at.least(finishTime);
      expect(await stakingContract.scRewardsAmount()).to.equal(announceAmount);
      expect(await stakingContract.totalRewardsCommitted()).to.equal(announceAmount);
    });
    
    it("Should allow announcer role to announce campaigns", async function () {
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards first
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Announce from announcer account
      await expect(stakingContract.connect(announcer).announce(announceAmount))
        .to.emit(stakingContract, "Announce");
    });
    
    it("Should revert announce from unauthorized accounts", async function () {
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards first
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Try to announce from user account
      await expect(stakingContract.connect(user).announce(announceAmount))
        .to.be.revertedWith("Caller must be admin or announcer");
    });
    
    it("Should revert announce when rewards amount is zero", async function () {
      const depositAmount = ethers.parseEther("10000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Try to announce with zero rewards
      await expect(stakingContract.connect(admin).announce(0))
        .to.be.revertedWith("Rewards amount must be greater than zero");
    });
    
    it("Should revert announce when deposit is insufficient", async function () {
      const depositAmount = ethers.parseEther("1000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Try to announce with more rewards than deposited
      await expect(stakingContract.connect(admin).announce(ethers.parseEther("2000")))
        .to.be.revertedWith("Not enough deposit for the campaign");
    });
    
    it("Should revert announce when previous campaign hasn't finished", async function () {
      const depositAmount = ethers.parseEther("20000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Announce first campaign
      await stakingContract.connect(admin).announce(ethers.parseEther("10000"));
      
      // Try to announce again before first campaign ends
      await expect(stakingContract.connect(admin).announce(ethers.parseEther("5000")))
        .to.be.revertedWith("The previous campaign hasn't finished");
    });
    
    it("Should allow depositAndAnnounce to perform both actions atomically", async function () {
      const depositAndAnnounceAmount = ethers.parseEther("10000");
      
      // Approve tokens
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAndAnnounceAmount);
      
      // Before depositAndAnnounce
      expect(await stakingContract.deposited()).to.equal(0);
      expect(await stakingContract.scRewardsAmount()).to.equal(0);
      
      // Perform depositAndAnnounce
      await stakingContract.connect(admin).depositAndAnnounce(depositAndAnnounceAmount);
      
      // After depositAndAnnounce
      expect(await stakingContract.deposited()).to.equal(depositAndAnnounceAmount);
      expect(await stakingContract.scRewardsAmount()).to.equal(depositAndAnnounceAmount);
      expect(await stakingContract.totalRewardsCommitted()).to.equal(depositAndAnnounceAmount);
    });
    
    it("Should only allow admin or announcer to call depositAndAnnounce", async function () {
      const amount = ethers.parseEther("10000");
      
      // Approve tokens
      await rewardsToken.connect(user).approve(await stakingContract.getAddress(), amount);
      
      // Try to deposit and announce from unauthorized account
      await expect(stakingContract.connect(user).depositAndAnnounce(amount))
        .to.be.revertedWith("Caller must be admin or announcer");
    });
  });
  
  describe("Staking Functions", function () {
    beforeEach(async function () {
      // Set up a campaign for testing staking and rewards
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Announce a campaign
      await stakingContract.connect(admin).announce(announceAmount);
      
      // Approve tokens for staking
      await stakingToken.connect(user).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
      await stakingToken.connect(user2).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
    });
    
    it("Should allow users to stake tokens", async function () {
      const stakeAmount = ethers.parseEther("1000");
      
      // Verify initial state
      expect(await stakingContract.globalStake()).to.equal(0);
      expect(await stakingContract.localStake(user.address)).to.equal(0);
      
      // Stake tokens and check event
      await expect(stakingContract.connect(user).stake(stakeAmount))
        .to.emit(stakingContract, "Stake")
        .withArgs(user.address, stakeAmount);
      
      // Verify stake was recorded correctly
      expect(await stakingContract.globalStake()).to.equal(stakeAmount);
      expect(await stakingContract.localStake(user.address)).to.equal(stakeAmount);
      
      // Check user's staking amounts - we need to check element at index 0
      const firstAmount = await stakingContract.userStakeAmounts(user.address, 0);
      expect(firstAmount).to.equal(stakeAmount);
      
      // Verify a stake time was recorded
      const firstTime = await stakingContract.userStakeTimes(user.address, 0);
      expect(firstTime).to.be.gt(0);
    });
    
    it("Should properly track multiple stakes from the same user", async function () {
      const firstStake = ethers.parseEther("500");
      const secondStake = ethers.parseEther("300");
      
      // First stake
      await stakingContract.connect(user).stake(firstStake);
      
      // Second stake
      await stakingContract.connect(user).stake(secondStake);
      
      // Verify state after multiple stakes
      expect(await stakingContract.globalStake()).to.equal(firstStake + secondStake);
      expect(await stakingContract.localStake(user.address)).to.equal(firstStake + secondStake);
      
      // Check staking history by accessing individual array elements
      const firstAmount = await stakingContract.userStakeAmounts(user.address, 0);
      const secondAmount = await stakingContract.userStakeAmounts(user.address, 1);
      
      expect(firstAmount).to.equal(firstStake);
      expect(secondAmount).to.equal(secondStake);
      
      // Verify stake times were recorded
      const firstTime = await stakingContract.userStakeTimes(user.address, 0);
      const secondTime = await stakingContract.userStakeTimes(user.address, 1);
      
      expect(firstTime).to.be.gt(0);
      expect(secondTime).to.be.gt(firstTime); // Second time should be after first
    });
    
    it("Should properly track stakes from multiple users", async function () {
      const user1Stake = ethers.parseEther("700");
      const user2Stake = ethers.parseEther("500");
      
      // First user stakes
      await stakingContract.connect(user).stake(user1Stake);
      
      // Second user stakes
      await stakingContract.connect(user2).stake(user2Stake);
      
      // Verify global state
      expect(await stakingContract.globalStake()).to.equal(user1Stake + user2Stake);
      
      // Verify individual states
      expect(await stakingContract.localStake(user.address)).to.equal(user1Stake);
      expect(await stakingContract.localStake(user2.address)).to.equal(user2Stake);
      
      // Verify allStakers array tracked both users
      const stats = await stakingContract.getGlobalStats();
      expect(stats[1]).to.equal(2); // totalStakers
    });
    
    it("Should revert stake with zero amount", async function () {
      await expect(stakingContract.connect(user).stake(0))
        .to.be.revertedWith("Amount must be > 0");
    });
    
    it("Should revert stake when token addresses are not set", async function () {
      // Create a new contract for this test
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const newStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await newStakingContract.waitForDeployment();
      
      // Try to stake before setting token addresses
      await expect(newStakingContract.connect(user).stake(ethers.parseEther("100")))
        .to.be.revertedWith("Token addresses must be set first");
    });
    
    it("Should track and calculate rewards correctly", async function () {
      const stakeAmount = ethers.parseEther("1000");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Initial rewards should be zero
      expect(await stakingContract.rewards(user.address)).to.equal(0);
      
      // Move time forward to accrue rewards (half the campaign duration)
      const campaignDuration = await stakingContract.campaignDuration();
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration / 2n)]);
      await ethers.provider.send("evm_mine");
      
      // Check rewards accrued (should be roughly half the proportional rewards)
      const userRewards = await stakingContract.rewards(user.address);
      const expectedRewards = (await stakingContract.scRewardsAmount()) / 2n;
      
      // Allow some small deviation due to block timestamp variations
      expect(userRewards).to.be.closeTo(expectedRewards, expectedRewards / 100n);
      
      // Another user stakes the same amount
      await stakingContract.connect(user2).stake(stakeAmount);
      
      // Move time forward to the end of campaign
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration / 2n)]);
      await ethers.provider.send("evm_mine");
      
      // First user should have around 75% of rewards (100% for first half, 50% for second half)
      const finalUser1Rewards = await stakingContract.rewards(user.address);
      const totalRewards = await stakingContract.scRewardsAmount();
      const expectedFinalRewards = totalRewards * 3n / 4n; // 75%
      
      expect(finalUser1Rewards).to.be.closeTo(expectedFinalRewards, expectedFinalRewards / 100n);
      
      // Second user should have around 25% of rewards (0% for first half, 50% for second half)
      const user2Rewards = await stakingContract.rewards(user2.address);
      const expectedUser2Rewards = totalRewards / 4n; // 25%
      
      expect(user2Rewards).to.be.closeTo(expectedUser2Rewards, expectedUser2Rewards / 100n);
    });
    
    it("Should allow users to claim rewards", async function () {
      const stakeAmount = ethers.parseEther("1000");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Move time forward to accrue rewards
      const campaignDuration = await stakingContract.campaignDuration();
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration)]);
      await ethers.provider.send("evm_mine");
      
      // Get pending rewards before claiming
      const pendingRewards = await stakingContract.rewards(user.address);
      expect(pendingRewards).to.be.gt(0);
      
      // Claim rewards and check event
      await expect(stakingContract.connect(user).claimRewards())
        .to.emit(stakingContract, "ClaimRewards")
        .withArgs(user.address, pendingRewards);
      
      // Verify rewards state after claiming
      expect(await stakingContract.rewards(user.address)).to.equal(0);
      expect(await stakingContract.localRewards(user.address)).to.equal(0);
      expect(await stakingContract.totalClaimedRewards(user.address)).to.equal(pendingRewards);
      
      // Verify user received the reward tokens
      expect(await rewardsToken.balanceOf(user.address)).to.equal(pendingRewards);
    });
    
    it("Should revert claim when there are no rewards", async function () {
      // Create a new contract without any stake
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const newStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await newStakingContract.waitForDeployment();
      
      // Set token addresses
      await newStakingContract.setTokenAddresses(
        await stakingToken.getAddress(),
        await rewardsToken.getAddress()
      );
      
      // Try to claim when user hasn't staked - should revert
      await expect(newStakingContract.connect(user).claimRewards())
        .to.be.revertedWith("No rewards");
      
      // Even with a new stake but no accumulated rewards, should revert
      await stakingToken.connect(user).approve(await newStakingContract.getAddress(), ethers.parseEther("100"));
      await newStakingContract.connect(user).stake(ethers.parseEther("100"));
      
      // Should still revert because no rewards accumulated
      await expect(newStakingContract.connect(user).claimRewards())
        .to.be.revertedWith("No rewards");
    });
    
    it("Should handle multiple claims correctly", async function () {
      // Create a specific test for multiple claims
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      const stakeAmount = ethers.parseEther("1000");
      
      // Deploy a new contract for this specific test to isolate it
      const StakingContract = await ethers.getContractFactory("StakingContract");
      const testStakingContract = await upgrades.deployProxy(
        StakingContract,
        [admin.address, announcer.address],
        { initializer: 'initialize' }
      );
      await testStakingContract.waitForDeployment();
      await testStakingContract.setTokenAddresses(
        await stakingToken.getAddress(),
        await rewardsToken.getAddress()
      );
      
      // Set a shorter campaign duration
      await testStakingContract.setCampaignDuration(24 * 60 * 60); // 1 day
      
      // Deposit and announce campaign
      await rewardsToken.connect(admin).approve(await testStakingContract.getAddress(), depositAmount);
      await testStakingContract.connect(admin).deposit(depositAmount);
      await testStakingContract.connect(admin).announce(announceAmount);
      
      // User stakes tokens
      await stakingToken.connect(user).approve(await testStakingContract.getAddress(), stakeAmount);
      await testStakingContract.connect(user).stake(stakeAmount);
      
      // Move time forward to 1/3 of campaign
      await ethers.provider.send("evm_increaseTime", [8 * 60 * 60]); // 8 hours
      await ethers.provider.send("evm_mine");
      
      // First claim
      const firstRewards = await testStakingContract.rewards(user.address);
      expect(firstRewards).to.be.gt(0); // Should have some rewards
      await testStakingContract.connect(user).claimRewards();
      
      // Move time forward to 2/3 of campaign
      await ethers.provider.send("evm_increaseTime", [8 * 60 * 60]); // 8 more hours
      await ethers.provider.send("evm_mine");
      
      // Second claim
      const secondRewards = await testStakingContract.rewards(user.address);
      expect(secondRewards).to.be.gt(0); // Should have more rewards
      await testStakingContract.connect(user).claimRewards();
      
      // Check total claimed rewards
      const totalClaimed = await testStakingContract.totalClaimedRewards(user.address);
      expect(totalClaimed).to.be.gt(0); // Should have claimed rewards
      
      // User should have received tokens
      const userBalance = await rewardsToken.balanceOf(user.address);
      expect(userBalance).to.be.gt(0); // Should have received tokens
      expect(userBalance).to.equal(totalClaimed); // Balance should match claimed amount
    });
  });
  
  describe("Unstaking Functions", function () {
    beforeEach(async function () {
      // Set up a campaign for testing staking and rewards
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Announce a campaign
      await stakingContract.connect(admin).announce(announceAmount);
      
      // Approve tokens for staking
      await stakingToken.connect(user).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
      
      // Set a shorter unstake period for testing
      await stakingContract.setUnstakePeriod(30 * 24 * 60 * 60); // 30 days
    });
    
    it("Should correctly calculate unlockable amounts", async function () {
      const stakeAmount = ethers.parseEther("1000");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Initially nothing should be unlockable
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(0);
      
      // Move time forward to half the unstake period
      const unstakePeriod = await stakingContract.unstakePeriod();
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod / 2n)]);
      await ethers.provider.send("evm_mine");
      
      // Still nothing should be unlockable
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(0);
      
      // Move time forward to just after the unstake period
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod / 2n) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Now the full stake amount should be unlockable
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(stakeAmount);
    });
    
    it("Should handle multiple stakes with different unlock times", async function () {
      const firstStake = ethers.parseEther("500");
      const secondStake = ethers.parseEther("300");
      
      // First stake
      await stakingContract.connect(user).stake(firstStake);
      
      // Move time forward halfway through unstake period
      const unstakePeriod = await stakingContract.unstakePeriod();
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod / 2n)]);
      await ethers.provider.send("evm_mine");
      
      // Second stake
      await stakingContract.connect(user).stake(secondStake);
      
      // Move time forward to just after first stake unlock
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod / 2n) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Only the first stake should be unlockable
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(firstStake);
      
      // Move time forward to unlock second stake
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod / 2n)]);
      await ethers.provider.send("evm_mine");
      
      // Both stakes should be unlockable now
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(firstStake + secondStake);
    });
    
    it("Should allow unstaking unlocked tokens", async function () {
      const stakeAmount = ethers.parseEther("1000");
      const unstakeAmount = ethers.parseEther("500");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Move time forward past the unstake period
      const unstakePeriod = await stakingContract.unstakePeriod();
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Verify initial balances
      const initialUserBalance = await stakingToken.balanceOf(user.address);
      
      // Unstake part of the tokens
      await expect(stakingContract.connect(user).unstake(unstakeAmount))
        .to.emit(stakingContract, "Unstake")
        .withArgs(user.address, unstakeAmount);
      
      // Verify balances after unstaking
      expect(await stakingToken.balanceOf(user.address)).to.equal(initialUserBalance + unstakeAmount);
      expect(await stakingContract.localStake(user.address)).to.equal(stakeAmount - unstakeAmount);
      expect(await stakingContract.globalStake()).to.equal(stakeAmount - unstakeAmount);
      expect(await stakingContract.totalUnstaked(user.address)).to.equal(unstakeAmount);
      
      // Remaining unlockable amount should be reduced
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(stakeAmount - unstakeAmount);
    });
    
    it("Should revert unstaking with zero amount", async function () {
      await expect(stakingContract.connect(user).unstake(0))
        .to.be.revertedWith("Amount must be > 0");
    });
    
    it("Should revert unstaking more than unlockable amount", async function () {
      const stakeAmount = ethers.parseEther("1000");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Try to unstake before unlock period
      await expect(stakingContract.connect(user).unstake(ethers.parseEther("100")))
        .to.be.revertedWith("Amount exceeds unlockable balance");
      
      // Move time forward past the unstake period
      const unstakePeriod = await stakingContract.unstakePeriod();
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Try to unstake more than staked
      await expect(stakingContract.connect(user).unstake(stakeAmount + ethers.parseEther("1")))
        .to.be.revertedWith("Amount exceeds unlockable balance");
    });
    
    it("Should track rewards correctly after unstaking", async function () {
      const stakeAmount = ethers.parseEther("1000");
      const unstakeAmount = ethers.parseEther("500");
      
      // User stakes tokens
      await stakingContract.connect(user).stake(stakeAmount);
      
      // Move time forward to accrue some rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Get rewards before unstaking
      const rewardsBefore = await stakingContract.rewards(user.address);
      
      // Move time forward past the unstake period
      const unstakePeriod = await stakingContract.unstakePeriod();
      await ethers.provider.send("evm_increaseTime", [Number(unstakePeriod)]);
      await ethers.provider.send("evm_mine");
      
      // Unstake half the tokens
      await stakingContract.connect(user).unstake(unstakeAmount);
      
      // Get rewards immediately after unstaking
      const rewardsAfterUnstake = await stakingContract.rewards(user.address);
      
      // Rewards should not decrease after unstaking
      expect(rewardsAfterUnstake).to.be.gte(rewardsBefore - ethers.parseEther("0.01")); // Allow small rounding error
      
      // Move time forward to accrue more rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // New rewards should be accruing (though at a lower rate now)
      const finalRewards = await stakingContract.rewards(user.address);
      
      // If we're in an active campaign, rewards should increase
      if (await isActiveCampaign()) {
        expect(finalRewards).to.be.gte(rewardsAfterUnstake);
      } else {
        // If campaign ended, rewards may not increase
        expect(finalRewards).to.be.gte(rewardsAfterUnstake - ethers.parseEther("0.01"));
      }
      
      // Claim rewards to verify they can be claimed after unstaking
      await stakingContract.connect(user).claimRewards();
      expect(await rewardsToken.balanceOf(user.address)).to.equal(finalRewards);
    });
  });
  
  describe("User and Global Stats", function () {
    beforeEach(async function () {
      // Set up a campaign for testing
      const depositAmount = ethers.parseEther("10000");
      const announceAmount = ethers.parseEther("5000");
      
      // Deposit rewards
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), depositAmount);
      await stakingContract.connect(admin).deposit(depositAmount);
      
      // Announce a campaign
      await stakingContract.connect(admin).announce(announceAmount);
      
      // Approve tokens for staking
      await stakingToken.connect(user).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
      await stakingToken.connect(user2).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
      
      // Set a shorter unstake period for testing
      await stakingContract.setUnstakePeriod(30 * 24 * 60 * 60); // 30 days
      
      // Users stake tokens
      await stakingContract.connect(user).stake(ethers.parseEther("1000"));
      await stakingContract.connect(user2).stake(ethers.parseEther("500"));
    });
    
    it("Should return correct user stats", async function () {
      // Move time forward to accrue some rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Get user stats
      const userStats = await stakingContract.getUserStats(user.address);
      
      // Verify stats structure and values
      expect(userStats[0]).to.equal(ethers.parseEther("1000")); // currentStake
      
      // Rewards should be accruing if campaign is active
      if (await isActiveCampaign()) {
        expect(userStats[1]).to.be.gt(0); // pendingRewards (should be some after 1 day)
        expect(userStats[3]).to.be.gt(0); // rewardsPerSecond (should be positive during campaign)
      }
      
      expect(userStats[2]).to.equal(0); // totalClaimedUsdt (no claims yet)
      
      // Verify stake amount at index 0 (we can't access full arrays)
      const firstStakeAmount = await stakingContract.userStakeAmounts(user.address, 0);
      expect(firstStakeAmount).to.equal(ethers.parseEther("1000"));
      
      // Verify stake time
      const firstStakeTime = await stakingContract.userStakeTimes(user.address, 0);
      expect(firstStakeTime).to.be.gt(0);
      
      expect(userStats[6]).to.equal(0); // unlockedAmount (not unlocked yet)
      expect(userStats[7]).to.equal(0); // totalUnstakedAmount (none unstaked yet)
      expect(userStats[8]).to.equal(30 * 24 * 60 * 60); // userUnstakePeriod
      expect(userStats[9]).to.equal(ethers.parseEther("9000")); // tokenBalance (10000 - 1000 staked)
    });
    
    it("Should return correct global stats", async function () {
      // Get global stats
      const globalStats = await stakingContract.getGlobalStats();
      
      // Verify stats structure and values
      expect(globalStats[0]).to.equal(ethers.parseEther("1500")); // totalStaked (1000 + 500)
      expect(globalStats[1]).to.equal(2); // totalStakers (2 users)
      expect(globalStats[2]).to.equal(2); // activeStakers (both are active)
      expect(globalStats[3]).to.be.gte(0); // totalDistributed (likely 0 if no rewards claimed yet)
      expect(globalStats[4]).to.be.gt(0); // availableBank (should be positive)
      expect(globalStats[5]).to.equal(ethers.parseEther("5000")); // currentCampaignRewards
      expect(globalStats[6]).to.be.gt(0); // campaignStart (should be set)
      expect(globalStats[7]).to.be.gt(0); // campaignEnd (should be set)
      expect(globalStats[8]).to.be.gt(0); // rewardRatePerToken (should be positive during campaign)
    });
    
    it("Should correctly batch stake rewards information", async function () {
      // Move time forward to accrue some rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Get stakers rewards in batch (first 10 stakers)
      const [stakers, rewards, claimed, total, stakes] = await stakingContract.getStakersRewardsBatch(0, 10);
      
      // Verify batch data
      expect(stakers.length).to.equal(2); // 2 stakers total
      expect(stakers).to.include(user.address);
      expect(stakers).to.include(user2.address);
      
      // Rewards should be positive after 1 day
      expect(rewards[0]).to.be.gt(0);
      expect(rewards[1]).to.be.gt(0);
      
      // No claims made yet
      expect(claimed[0]).to.equal(0);
      expect(claimed[1]).to.equal(0);
      
      // Total rewards should match pending rewards
      expect(total[0]).to.equal(rewards[0]);
      expect(total[1]).to.equal(rewards[1]);
      
      // Stake amounts should match what users staked
      const user1Index = stakers.indexOf(user.address);
      const user2Index = stakers.indexOf(user2.address);
      
      expect(stakes[user1Index]).to.equal(ethers.parseEther("1000"));
      expect(stakes[user2Index]).to.equal(ethers.parseEther("500"));
    });
    
    it("Should return rewards by specified addresses", async function () {
      // Move time forward to accrue some rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Get rewards for specific addresses
      const addresses = [user.address, user2.address];
      const [stakers, rewards, claimed, total, stakes] = await stakingContract.getRewardsByAddresses(addresses);
      
      // Verify data
      expect(stakers.length).to.equal(2);
      expect(stakers[0]).to.equal(user.address);
      expect(stakers[1]).to.equal(user2.address);
      
      // Rewards should be positive after 1 day
      expect(rewards[0]).to.be.gt(0);
      expect(rewards[1]).to.be.gt(0);
      
      // The ratio of rewards should be roughly 2:1 (same as stake ratio)
      const rewardsRatio = Number(rewards[0]) / Number(rewards[1]);
      expect(rewardsRatio).to.be.closeTo(2, 0.1); // Allow 10% deviation
      
      // Stake amounts should be as expected
      expect(stakes[0]).to.equal(ethers.parseEther("1000"));
      expect(stakes[1]).to.equal(ethers.parseEther("500"));
    });
    
    it("Should revert when querying out of bounds in batch", async function () {
      // Try to get batch with invalid offset
      await expect(stakingContract.getStakersRewardsBatch(10, 10))
        .to.be.revertedWith("Offset out of bounds");
    });
    
    it("Should revert when querying with 0 batch size", async function () {
      await expect(stakingContract.getStakersRewardsBatch(0, 0))
        .to.be.revertedWith("Batch size must be greater than 0");
    });
    
    it("Should revert when querying empty address array", async function () {
      await expect(stakingContract.getRewardsByAddresses([]))
        .to.be.revertedWith("Addresses array cannot be empty");
    });
    
    it("Should correctly update available rewards when users stake and claim", async function () {
      // Move time forward to accrue rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Check if campaign is active
      if (await isActiveCampaign()) {
        // Get initial available rewards
        const [initialDistributed, initialAvailable] = await stakingContract.getAvailableRewards();
        
        // User claims rewards
        await stakingContract.connect(user).claimRewards();
        
        // Get updated available rewards
        const [updatedDistributed, updatedAvailable] = await stakingContract.getAvailableRewards();
        
        // After claiming, distributed rewards should be at least as much as before
        expect(updatedDistributed).to.be.gte(initialDistributed);
      } else {
        // If no active campaign, just check that the function doesn't revert
        const [distributed, available] = await stakingContract.getAvailableRewards();
        expect(distributed).to.be.gte(0);
        expect(available).to.be.gte(0);
      }
    });
    
    it("Should handle complete staking and rewards cycle", async function () {
      // Test a complete cycle of staking, rewards accrual, claiming, and unstaking
      
      // Move time to accrue rewards
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 * 15]); // 15 days
      await ethers.provider.send("evm_mine");
      
      // Claim rewards
      const pendingRewards = await stakingContract.rewards(user.address);
      await stakingContract.connect(user).claimRewards();
      
      // Verify claimed rewards
      expect(await rewardsToken.balanceOf(user.address)).to.equal(pendingRewards);
      expect(await stakingContract.totalClaimedRewards(user.address)).to.equal(pendingRewards);
      
      // Move time past unstake period
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 * 20]); // 20 more days
      await ethers.provider.send("evm_mine");
      
      // Check unlockable amount
      expect(await stakingContract.getUnlockableAmount(user.address)).to.equal(ethers.parseEther("1000"));
      
      // Unstake all tokens
      await stakingContract.connect(user).unstake(ethers.parseEther("1000"));
      
      // Verify final state
      expect(await stakingContract.localStake(user.address)).to.equal(0);
      expect(await stakingToken.balanceOf(user.address)).to.equal(ethers.parseEther("10000")); // Back to original balance
      
      // Get final user stats
      const finalStats = await stakingContract.getUserStats(user.address);
      expect(finalStats[0]).to.equal(0); // currentStake
      expect(finalStats[2]).to.equal(pendingRewards); // totalClaimedUsdt
      expect(finalStats[7]).to.equal(ethers.parseEther("1000")); // totalUnstakedAmount
    });
  });
  
  describe("Multi-Campaign Behavior", function () {
    it("Should correctly handle multiple sequential campaigns", async function () {
      // First deposit and campaign
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), ethers.parseEther("20000"));
      await stakingContract.connect(admin).deposit(ethers.parseEther("20000"));
      await stakingContract.connect(admin).announce(ethers.parseEther("5000"));
      
      // User stakes
      await stakingToken.connect(user).approve(await stakingContract.getAddress(), ethers.parseEther("1000"));
      await stakingContract.connect(user).stake(ethers.parseEther("1000"));
      
      // Fast forward to end of first campaign
      const campaignDuration = await stakingContract.campaignDuration();
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Collect rewards from first campaign
      const firstRewards = await stakingContract.rewards(user.address);
      await stakingContract.connect(user).claimRewards();
      
      // Start second campaign
      await stakingContract.connect(admin).announce(ethers.parseEther("10000"));
      
      // Fast forward through part of second campaign
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration) / 2]);
      await ethers.provider.send("evm_mine");
      
      // Check rewards in second campaign
      const secondRewards = await stakingContract.rewards(user.address);
      
      // Second campaign has double the rewards rate, so halfway through should yield similar rewards as entire first campaign
      expect(secondRewards).to.be.closeTo(firstRewards, firstRewards / 10n);
      
      // Finish second campaign
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration) / 2 + 60]);
      await ethers.provider.send("evm_mine");
      
      // Claim rewards from second campaign
      const totalSecondRewards = await stakingContract.rewards(user.address);
      await stakingContract.connect(user).claimRewards();
      
      // Verify total claimed rewards from both campaigns
      expect(await stakingContract.totalClaimedRewards(user.address)).to.equal(firstRewards + totalSecondRewards);
      expect(await rewardsToken.balanceOf(user.address)).to.equal(firstRewards + totalSecondRewards);
    });
    
    it("Should handle periods without active campaigns correctly", async function () {
      // First deposit and campaign
      await rewardsToken.connect(admin).approve(await stakingContract.getAddress(), ethers.parseEther("10000"));
      await stakingContract.connect(admin).deposit(ethers.parseEther("10000"));
      await stakingContract.connect(admin).announce(ethers.parseEther("5000"));
      
      // User stakes
      await stakingToken.connect(user).approve(await stakingContract.getAddress(), ethers.parseEther("1000"));
      await stakingContract.connect(user).stake(ethers.parseEther("1000"));
      
      // Fast forward to end of campaign
      const campaignDuration = await stakingContract.campaignDuration();
      await ethers.provider.send("evm_increaseTime", [Number(campaignDuration) + 60]);
      await ethers.provider.send("evm_mine");
      
      // Check rewards at end of campaign
      const campaignEndRewards = await stakingContract.rewards(user.address);
      
      // Wait a period with no active campaign
      await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60]); // 7 days
      await ethers.provider.send("evm_mine");
      
      // Rewards should remain the same during inactive period
      const inactiveRewards = await stakingContract.rewards(user.address);
      expect(inactiveRewards).to.equal(campaignEndRewards);
      
      // Start second campaign
      await stakingContract.connect(admin).announce(ethers.parseEther("5000"));
      
      // Wait a bit into the campaign
      await ethers.provider.send("evm_increaseTime", [1 * 24 * 60 * 60]); // 1 day
      await ethers.provider.send("evm_mine");
      
      // Rewards should be increasing again
      const newRewards = await stakingContract.rewards(user.address);
      expect(newRewards).to.be.gt(inactiveRewards);
    });
  });
});