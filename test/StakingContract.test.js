const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("StakingContract", function () {
  let stakingContract;
  let stakingToken;
  let rewardsToken;
  let admin;
  let announcer;
  let user;

  beforeEach(async function () {
    // Get signers
    [admin, announcer, user] = await ethers.getSigners();
    
    // Deploy mock tokens for testing
    const MockToken = await ethers.getContractFactory("MockToken");
    stakingToken = await MockToken.deploy("Staking Token", "STK", 18, admin.address);
    await stakingToken.deploymentTransaction().wait();
    
    rewardsToken = await MockToken.deploy("Rewards Token", "RWD", 18, admin.address);
    await rewardsToken.deploymentTransaction().wait();
    
    // Deploy the StakingContract
    const StakingContract = await ethers.getContractFactory("StakingContract");
    stakingContract = await StakingContract.deploy();
    await stakingContract.deploymentTransaction().wait();
    
    // Initialize the staking contract with admin and announcer multisigs
    await stakingContract.initialize(admin.address, announcer.address);
    
    // Set token addresses
    await stakingContract.setTokenAddresses(
      await stakingToken.getAddress(),
      await rewardsToken.getAddress()
    );
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
      const newStakingContract = await StakingContract.deploy();
      await newStakingContract.initialize(admin.address, announcer.address);
      
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
      const newStakingContract = await StakingContract.deploy();
      await newStakingContract.initialize(admin.address, announcer.address);
      
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
});