const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SwapContract", function () {
  let swapContract;
  let mainToken;
  let mockUSDT;
  let mockPriceFeed;
  let mockRouter;
  let admin;
  let funding;
  let user;
  let anotherToken;
  let mockRouterFactory;

  beforeEach(async function () {
    // Get signers
    [admin, funding, user, otherUser] = await ethers.getSigners();
    
    // Deploy mock tokens for testing
    const MockToken = await ethers.getContractFactory("MockToken");
    
    // Deploy mock USDT token
    mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 18, admin.address);
    await mockUSDT.deploymentTransaction().wait();
    
    // Deploy main token
    mainToken = await MockToken.deploy("Bobe Token", "BOBE", 18, admin.address);
    await mainToken.deploymentTransaction().wait();
    
    // Deploy another token for testing swapAnyTokens
    anotherToken = await MockToken.deploy("Another Token", "ATK", 18, admin.address);
    await anotherToken.deploymentTransaction().wait();
    
    // Deploy mock price feed
    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    mockPriceFeed = await MockV3Aggregator.deploy(8, 30000000000); // 8 decimals, $300 BNB price
    await mockPriceFeed.deploymentTransaction().wait();
    
    // Deploy a mock router contract
    mockRouterFactory = await ethers.getContractFactory("MockPancakeRouter");
    mockRouter = await mockRouterFactory.deploy(await mockUSDT.getAddress());
    await mockRouter.deploymentTransaction().wait();
    
    // Deploy the SwapContract
    const SwapContract = await ethers.getContractFactory("SwapContract");
    swapContract = await SwapContract.deploy();
    await swapContract.deploymentTransaction().wait();
    
    // Initialize the SwapContract
    await swapContract.initialize(admin.address, funding.address);
    
    // Set required addresses
    await swapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
    await swapContract.setUsdtAddress(await mockUSDT.getAddress());
    await swapContract.setSmartRouterAddress(await mockRouter.getAddress());
    
    // Allow USDT as a stablecoin
    await swapContract.allowStableToken(await mockUSDT.getAddress());
    
    // Transfer tokens to the contract and user
    await mainToken.mint(await swapContract.getAddress(), ethers.parseEther("1000000"));
    await mockUSDT.mint(user.address, ethers.parseEther("10000"));
    await anotherToken.mint(user.address, ethers.parseEther("10000"));
    
    // Set main token address
    await swapContract.setMainTokenAddress(await mainToken.getAddress());
  });

  describe("Deployment", function () {
    it("Should deploy the contract with correct initial values", async function () {
      // Check funding address is set correctly
      expect(await swapContract.fundingAddress()).to.equal(funding.address);
      
      // Check main token is set correctly
      expect(await swapContract.mainTokenAddress()).to.equal(await mainToken.getAddress());
      
      // Check token price is set to default (1.1 USDT)
      expect(await swapContract.mainTokenPriceInUsdt()).to.equal(ethers.parseEther("1.1"));
      
      // Check admin role is set correctly
      const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
      expect(await swapContract.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
    });

    it("Should set external addresses correctly", async function () {
      // Check BNB price feed is set
      expect(await swapContract.bnbPriceFeed()).to.equal(await mockPriceFeed.getAddress());
      
      // Check USDT address is set
      expect(await swapContract.usdtAddress()).to.equal(await mockUSDT.getAddress());
      
      // Check router address is set
      expect(await swapContract.smartRouterAddress()).to.equal(await mockRouter.getAddress());
    });

    it("Should allow stable tokens correctly", async function () {
      // Check our USDT is allowed
      expect(await swapContract.allowedStableTokens(await mockUSDT.getAddress())).to.be.true;
      
      // Deploy a new token
      const MockToken = await ethers.getContractFactory("MockToken");
      const newStable = await MockToken.deploy("New Stable", "NSTBL", 18, admin.address);
      
      // Not allowed initially
      expect(await swapContract.allowedStableTokens(await newStable.getAddress())).to.be.false;
      
      // Allow the token
      await swapContract.allowStableToken(await newStable.getAddress());
      
      // Now it should be allowed
      expect(await swapContract.allowedStableTokens(await newStable.getAddress())).to.be.true;
    });
    
    it("Should emit MainTokenSet event when setting main token", async function () {
      // Create a new SwapContract for this test
      const SwapContract = await ethers.getContractFactory("SwapContract");
      const newSwapContract = await SwapContract.deploy();
      await newSwapContract.deploymentTransaction().wait();
      
      // Initialize it
      await newSwapContract.initialize(admin.address, funding.address);
      
      // Set other required addresses
      await newSwapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
      await newSwapContract.setUsdtAddress(await mockUSDT.getAddress());
      await newSwapContract.setSmartRouterAddress(await mockRouter.getAddress());
      
      // Transfer tokens to the contract
      await mainToken.mint(await newSwapContract.getAddress(), ethers.parseEther("1000000"));
      
      // Verify the event is emitted with the correct parameters
      await expect(newSwapContract.setMainTokenAddress(await mainToken.getAddress()))
        .to.emit(newSwapContract, "MainTokenSet")
        .withArgs(await mainToken.getAddress());
    });
    
    it("Should emit FundingAddressSet event when setting funding address", async function () {
      const newFundingAddress = user.address;
      
      await expect(swapContract.setFundingAddress(newFundingAddress))
        .to.emit(swapContract, "FundingAddressSet")
        .withArgs(newFundingAddress);
        
      expect(await swapContract.fundingAddress()).to.equal(newFundingAddress);
    });
    
    it("Should emit UsdtAddressSet event when updating USDT address", async function () {
      // Create a new token for testing
      const MockToken = await ethers.getContractFactory("MockToken");
      const newUSDT = await MockToken.deploy("New USDT", "NUSDT", 18, admin.address);
      const newUSDTAddress = await newUSDT.getAddress();
      
      // Verify event emission
      await expect(swapContract.setUsdtAddress(newUSDTAddress))
        .to.emit(swapContract, "UsdtAddressSet")
        .withArgs(newUSDTAddress);
      
      // Check it was set correctly
      expect(await swapContract.usdtAddress()).to.equal(newUSDTAddress);
    });
    
    it("Should emit BnbPriceFeedSet event when updating BNB price feed", async function () {
      // Create a new price feed for testing
      const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
      const newPriceFeed = await MockV3Aggregator.deploy(8, 40000000000); // $400 BNB price
      const newPriceFeedAddress = await newPriceFeed.getAddress();
      
      // Verify event emission
      await expect(swapContract.setBnbPriceFeed(newPriceFeedAddress))
        .to.emit(swapContract, "BnbPriceFeedSet")
        .withArgs(newPriceFeedAddress);
      
      // Check it was set correctly
      expect(await swapContract.bnbPriceFeed()).to.equal(newPriceFeedAddress);
    });
    
    it("Should emit SmartRouterSet event when updating router address", async function () {
      // Set a new router address
      const newRouterAddress = user.address;
      
      // Verify event emission
      await expect(swapContract.setSmartRouterAddress(newRouterAddress))
        .to.emit(swapContract, "SmartRouterSet")
        .withArgs(newRouterAddress);
      
      // Check it was set correctly
      expect(await swapContract.smartRouterAddress()).to.equal(newRouterAddress);
    });
  });

  describe("Token Management", function() {
    it("Should disallow a previously allowed token", async function() {
      const usdtAddress = await mockUSDT.getAddress();
      
      // Verify it's allowed initially
      expect(await swapContract.allowedStableTokens(usdtAddress)).to.be.true;
      
      // Disallow the token
      await expect(swapContract.disallowStableToken(usdtAddress))
        .to.emit(swapContract, "TokenDisallowed")
        .withArgs(usdtAddress);
      
      // Verify it's no longer allowed
      expect(await swapContract.allowedStableTokens(usdtAddress)).to.be.false;
    });
    
    it("Should revert when trying to disallow a token that's not allowed", async function() {
      const tokenAddress = await anotherToken.getAddress();
      
      // Verify it's not allowed
      expect(await swapContract.allowedStableTokens(tokenAddress)).to.be.false;
      
      // Attempt to disallow should fail
      await expect(swapContract.disallowStableToken(tokenAddress))
        .to.be.revertedWith("Token not found in allowed lists");
    });
    
    it("Should not allow setting main token address more than once", async function() {
      // Create a new token
      const MockToken = await ethers.getContractFactory("MockToken");
      const newToken = await MockToken.deploy("New Token", "NTK", 18, admin.address);
      await newToken.mint(await swapContract.getAddress(), ethers.parseEther("1000"));
      
      // Try to set main token again
      await expect(swapContract.setMainTokenAddress(await newToken.getAddress()))
        .to.be.revertedWith("Main token address can only be set once");
    });
    
    it("Should not allow setting main token address to zero", async function() {
      // Create a new contract for this test
      const SwapContract = await ethers.getContractFactory("SwapContract");
      const newSwapContract = await SwapContract.deploy();
      await newSwapContract.initialize(admin.address, funding.address);
      
      // Try to set the main token to zero address
      await expect(newSwapContract.setMainTokenAddress(ethers.ZeroAddress))
        .to.be.revertedWith("Invalid main token address");
    });
    
    it("Should not allow setting the main token if contract has no balance", async function() {
      // Create a new SwapContract for this test
      const SwapContract = await ethers.getContractFactory("SwapContract");
      const newSwapContract = await SwapContract.deploy();
      await newSwapContract.initialize(admin.address, funding.address);
      
      // Try to set main token but contract has no balance
      await expect(newSwapContract.setMainTokenAddress(await mainToken.getAddress()))
        .to.be.revertedWith("No tokens available on contract balance");
    });
  });

  describe("Utility Functions", function() {
    it("Should convert between different decimal places correctly", async function() {
      // Same decimals
      expect(await swapContract.convertDecimals(1000, 18, 18)).to.equal(1000);
      
      // Higher to lower decimals
      expect(await swapContract.convertDecimals(1000000000, 9, 6)).to.equal(1000000);
      
      // Lower to higher decimals
      expect(await swapContract.convertDecimals(1000, 6, 9)).to.equal(1000000);
      
      // Edge cases
      expect(await swapContract.convertDecimals(0, 18, 6)).to.equal(0);
      expect(await swapContract.convertDecimals(ethers.parseEther("1"), 18, 6)).to.equal(1000000);
    });
    
    it("Should convert BNB to USDT correctly based on price feed", async function() {
      // 1 BNB at $300 (price feed value is $300 with 8 decimals)
      const bnbAmount = ethers.parseEther("1"); // 1 BNB
      
      // Expected: 1 BNB * $300 = $300 USDT
      const expectedUsdt = ethers.parseEther("300");
      
      expect(await swapContract.convertBnbToUsdt(bnbAmount)).to.equal(expectedUsdt);
    });
    
    it("Should revert when BNB price is stale", async function() {
      // Create a new price feed with stale data
      const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
      const stalePriceFeed = await MockV3Aggregator.deploy(8, 30000000000); // $300 BNB price
      
      // Set the round data to be stale
      await stalePriceFeed.setRoundData(1, 30000000000, 0, Math.floor(Date.now() / 1000) - 3700, 0); // Older than 1 hour
      
      // Set this as the price feed
      await swapContract.setBnbPriceFeed(await stalePriceFeed.getAddress());
      
      // Now the conversion should fail
      await expect(swapContract.convertBnbToUsdt(1000))
        .to.be.revertedWith("Oracle data too old");
    });
  });

  describe("Swap Native Token", function() {
    it("Should swap BNB for main tokens correctly", async function() {
      const bnbAmount = ethers.parseEther("1"); // 1 BNB
      
      // Expected USDT value: 1 BNB * $300 = $300 USDT
      const expectedUsdtValue = ethers.parseEther("300");
      
      // Expected main tokens: $300 USDT / $1.1 = 272.72... main tokens
      const expectedMainTokens = (expectedUsdtValue * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // Check balances before swap
      const userMainTokenBefore = await mainToken.balanceOf(user.address);
      const fundingBnbBefore = await ethers.provider.getBalance(funding.address);
      
      // Perform the swap
      await expect(swapContract.connect(user).swapNativeToken({value: bnbAmount}))
        .to.emit(swapContract, "NativeTokenPurchased")
        .withArgs(user.address, bnbAmount, expectedUsdtValue, expectedMainTokens);
      
      // Check balances after swap
      const userMainTokenAfter = await mainToken.balanceOf(user.address);
      const fundingBnbAfter = await ethers.provider.getBalance(funding.address);
      
      // User should have received main tokens
      expect(userMainTokenAfter - userMainTokenBefore).to.equal(expectedMainTokens);
      
      // Funding address should have received BNB
      expect(fundingBnbAfter - fundingBnbBefore).to.equal(bnbAmount);
    });
    
    it("Should revert when swapping zero BNB amount", async function() {
      await expect(swapContract.connect(user).swapNativeToken({value: 0}))
        .to.be.revertedWith("Amount must be greater than 0");
    });
    
    it("Should revert when insufficient main token balance", async function() {
      // Deploy a new contract for this test
      const SwapContract = await ethers.getContractFactory("SwapContract");
      const newSwapContract = await SwapContract.deploy();
      await newSwapContract.initialize(admin.address, funding.address);
      await newSwapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
      
      // Mint a small amount of main tokens to the contract
      await mainToken.mint(await newSwapContract.getAddress(), ethers.parseEther("1"));
      await newSwapContract.setMainTokenAddress(await mainToken.getAddress());
      
      // Try to swap an amount that requires more main tokens than available
      const largeAmount = ethers.parseEther("100"); // 100 BNB
      
      await expect(newSwapContract.connect(user).swapNativeToken({value: largeAmount}))
        .to.be.revertedWith("Insufficient main token balance");
    });
  });

  describe("Swap Stable Tokens", function() {
    it("Should swap stable tokens for main tokens correctly", async function() {
      const usdtAmount = ethers.parseEther("100"); // 100 USDT
      
      // Expected main tokens: 100 USDT / $1.1 = 90.909... main tokens
      const expectedMainTokens = (usdtAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // Approve the swap contract to spend USDT
      await mockUSDT.connect(user).approve(await swapContract.getAddress(), usdtAmount);
      
      // Check balances before swap
      const userMainTokenBefore = await mainToken.balanceOf(user.address);
      const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);
      
      // Perform the swap
      await expect(swapContract.connect(user).swapStableTokens(await mockUSDT.getAddress(), usdtAmount))
        .to.emit(swapContract, "TokensPurchased")
        .withArgs(user.address, await mockUSDT.getAddress(), usdtAmount, usdtAmount, expectedMainTokens);
      
      // Check balances after swap
      const userMainTokenAfter = await mainToken.balanceOf(user.address);
      const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);
      
      // User should have received main tokens
      expect(userMainTokenAfter - userMainTokenBefore).to.equal(expectedMainTokens);
      
      // Funding address should have received USDT
      expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(usdtAmount);
    });
    
    it("Should handle stable tokens with different decimals", async function() {
      // Deploy a 6-decimal token (like USDC)
      const MockToken = await ethers.getContractFactory("MockToken");
      const usdc = await MockToken.deploy("Mock USDC", "USDC", 6, admin.address);
      
      // Mint some tokens to the user
      await usdc.mint(user.address, 100_000_000); // 100 USDC with 6 decimals
      
      // Allow the token
      await swapContract.allowStableToken(await usdc.getAddress());
      
      // Approve the swap contract
      await usdc.connect(user).approve(await swapContract.getAddress(), 100_000_000);
      
      // Expected USDT value: 100 USDC = $100 USDT (conversion to 18 decimals)
      const expectedUsdtValue = ethers.parseEther("100");
      
      // Expected main tokens: $100 USDT / $1.1 = 90.909... main tokens
      const expectedMainTokens = (expectedUsdtValue * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // Check balances before
      const userMainTokenBefore = await mainToken.balanceOf(user.address);
      
      // Perform the swap
      await expect(swapContract.connect(user).swapStableTokens(await usdc.getAddress(), 100_000_000))
        .to.emit(swapContract, "TokensPurchased");
      
      // Check balances after
      const userMainTokenAfter = await mainToken.balanceOf(user.address);
      const mainTokensReceived = userMainTokenAfter - userMainTokenBefore;
      
      // Allow a small rounding error due to decimal conversion
      const tolerance = ethers.parseEther("0.000001");
      expect(mainTokensReceived).to.be.closeTo(expectedMainTokens, tolerance);
    });
    
    it("Should revert when token is not allowed", async function() {
      const tokenAmount = ethers.parseEther("100");
      
      // Try to swap a token that's not in the allowed list
      await expect(swapContract.connect(user).swapStableTokens(
        await anotherToken.getAddress(), tokenAmount
      )).to.be.revertedWith("Token not allowed");
    });
    
    it("Should revert when amount is zero", async function() {
      await expect(swapContract.connect(user).swapStableTokens(
        await mockUSDT.getAddress(), 0
      )).to.be.revertedWith("Amount must be greater than 0");
    });
    
    it("Should revert when main token is not initialized", async function() {
      // Create a new contract for this test
      const SwapContract = await ethers.getContractFactory("SwapContract");
      const newSwapContract = await SwapContract.deploy();
      await newSwapContract.initialize(admin.address, funding.address);
      
      // Allow USDT
      await newSwapContract.allowStableToken(await mockUSDT.getAddress());
      
      // Try to swap without main token being set
      await expect(newSwapContract.connect(user).swapStableTokens(
        await mockUSDT.getAddress(), ethers.parseEther("100")
      )).to.be.revertedWith("Main token address must be set first");
    });
  });

  describe("Swap Any Tokens", function() {
    beforeEach(async function() {
      // Set up mock router with exchange rates
      const atkAddress = await anotherToken.getAddress();
      const usdtAddress = await mockUSDT.getAddress();
      
      // Set up mock router to return 2 USDT for 1 ATK
      await mockRouter.setExchangeRate(atkAddress, usdtAddress, 2);
      
      // Mint USDT to the mock router (to simulate swap)
      await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));
    });
    
    it("Should swap non-stable tokens through the DEX router", async function() {
      const tokenAmount = ethers.parseEther("100"); // 100 ATK
      const path = [
        await anotherToken.getAddress(),
        await mockUSDT.getAddress()
      ];
      
      // Expected USDT: 100 ATK * 2 = 200 USDT
      const expectedUsdt = ethers.parseEther("200");
      
      // Expected main tokens: 200 USDT / $1.1 = 181.81... main tokens
      const expectedMainTokens = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // Approve token spending
      await anotherToken.connect(user).approve(await swapContract.getAddress(), tokenAmount);
      
      // Check balances before
      const userMainTokenBefore = await mainToken.balanceOf(user.address);
      const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);
      
      // Perform the swap with 0.5% slippage (50 bps)
      await expect(swapContract.connect(user).swapAnyTokens(
        await anotherToken.getAddress(), tokenAmount, path, 50
      )).to.emit(swapContract, "TokensPurchased");
      
      // Check balances after
      const userMainTokenAfter = await mainToken.balanceOf(user.address);
      const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);
      
      // User should have received main tokens
      expect(userMainTokenAfter - userMainTokenBefore).to.be.closeTo(expectedMainTokens, ethers.parseEther("0.01"));
      
      // Funding should have received USDT
      expect(fundingUsdtAfter - fundingUsdtBefore).to.be.closeTo(expectedUsdt, ethers.parseEther("0.01"));
    });
    
    it("Should revert when slippage is too high", async function() {
      const tokenAmount = ethers.parseEther("100"); // 100 ATK
      const path = [
        await anotherToken.getAddress(),
        await mockUSDT.getAddress()
      ];
      
      // Approve token spending
      await anotherToken.connect(user).approve(await swapContract.getAddress(), tokenAmount);
      
      // Slippage is 10% or more (1000 bps)
      await expect(swapContract.connect(user).swapAnyTokens(
        await anotherToken.getAddress(), tokenAmount, path, 1000
      )).to.be.revertedWith("Slippage too high");
    });
    
    it("Should revert when trying to swap a stable token", async function() {
      const tokenAmount = ethers.parseEther("100");
      const path = [
        await mockUSDT.getAddress(),
        await anotherToken.getAddress(),
        await mockUSDT.getAddress()
      ];
      
      await expect(swapContract.connect(user).swapAnyTokens(
        await mockUSDT.getAddress(), tokenAmount, path, 50
      )).to.be.revertedWith("Use swapStableTokens for stablecoins");
    });
    
    it("Should revert when the path is invalid", async function() {
      const tokenAmount = ethers.parseEther("100");
      
      // Path too short
      const shortPath = [await anotherToken.getAddress()];
      await expect(swapContract.connect(user).swapAnyTokens(
        await anotherToken.getAddress(), tokenAmount, shortPath, 50
      )).to.be.revertedWith("Path too short");
      
      // Path start doesn't match token
      const mismatchPath = [await mainToken.getAddress(), await mockUSDT.getAddress()];
      await expect(swapContract.connect(user).swapAnyTokens(
        await anotherToken.getAddress(), tokenAmount, mismatchPath, 50
      )).to.be.revertedWith("Path start must match input token");
      
      // Path doesn't end with USDT
      const wrongEndPath = [await anotherToken.getAddress(), await mainToken.getAddress()];
      await expect(swapContract.connect(user).swapAnyTokens(
        await anotherToken.getAddress(), tokenAmount, wrongEndPath, 50
      )).to.be.revertedWith("Path must end with USDT");
    });
  });

  describe("Access Control", function() {
    it("Should not allow non-admin to set addresses", async function() {
      await expect(swapContract.connect(user).setFundingAddress(otherUser.address))
        .to.be.reverted; // Check it reverts with access control error
        
      await expect(swapContract.connect(user).setUsdtAddress(otherUser.address))
        .to.be.reverted;
        
      await expect(swapContract.connect(user).setBnbPriceFeed(otherUser.address))
        .to.be.reverted;
        
      await expect(swapContract.connect(user).setSmartRouterAddress(otherUser.address))
        .to.be.reverted;
    });
    
    it("Should not allow non-admin to manage tokens", async function() {
      await expect(swapContract.connect(user).allowStableToken(otherUser.address))
        .to.be.reverted;
        
      await expect(swapContract.connect(user).disallowStableToken(await mockUSDT.getAddress()))
        .to.be.reverted;
    });
  });

  describe("Reentrancy Protection", function() {
    let attackToken;
    let attackerPath;
    
    beforeEach(async function() {
      // Deploy the attack token targeting our swap contract
      const AttackToken = await ethers.getContractFactory("ReentrancyAttackToken");
      attackToken = await AttackToken.deploy(
        "Attack Token", 
        "ATK",
        admin.address,
        await swapContract.getAddress(),
        await mockUSDT.getAddress()
      );
      await attackToken.deploymentTransaction().wait();
      
      // Set up attack parameters
      await attackToken.setAttackParameters(user.address, ethers.parseEther("50"));
      
      // Create a scenario where the attack token will be swapped
      attackerPath = [
        await attackToken.getAddress(),
        await mockUSDT.getAddress()
      ];
      
      // Set up mock router to return USDT for Attack token
      const atkAddress = await attackToken.getAddress();
      const usdtAddress = await mockUSDT.getAddress();
      await mockRouter.setExchangeRate(atkAddress, usdtAddress, 1);
      
      // Fund user with attack tokens and USDT for the attack
      await attackToken.transfer(user.address, ethers.parseEther("1000"));
      await mockUSDT.mint(user.address, ethers.parseEther("1000"));
      
      // Approve spending of tokens
      await mockUSDT.connect(user).approve(await swapContract.getAddress(), ethers.parseEther("1000"));
      await attackToken.connect(user).approve(await swapContract.getAddress(), ethers.parseEther("1000"));
      
      // Fund attack token with some USDT (for the attack)
      await mockUSDT.mint(await attackToken.getAddress(), ethers.parseEther("100"));
    });
    
    it("Should prevent reentrancy attacks between swap functions", async function() {
      // Setup initial balances
      const initialMainTokenBalance = await mainToken.balanceOf(user.address);
      const attackAmount = ethers.parseEther("100");
      
      // Enable attack mode in the malicious token
      await attackToken.enableAttack();
      
      // Attempt the attack scenario:
      // 1. swapAnyTokens is called with the attack token
      // 2. During transferFrom, the attack token tries to call swapStableTokens
      // 3. If reentrancy protection works, the second call should revert
      
      // Execute the attack - should either revert or not process the second swap
      await expect(swapContract.connect(user).swapAnyTokens(
        await attackToken.getAddress(), 
        attackAmount, 
        attackerPath, 
        100 // 1% slippage
      )).to.be.reverted;
      
      // If it didn't revert, check that only one swap happened by checking token balance
      // This is a backup check in case the attack actually went through but didn't revert
      const finalMainTokenBalance = await mainToken.balanceOf(user.address);
      const maxExpectedTokens = (attackAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // If double-swap happened, user would get 2x tokens, so check they didn't get more than expected
      // Allow a small tolerance for rounding errors
      expect(finalMainTokenBalance - initialMainTokenBalance).to.be.lessThanOrEqual(maxExpectedTokens);
    });
    
    it("Should test stableToken to stableToken reentrancy protection", async function() {
      // This test verifies that the reentrancy protection prevents double swaps in stableToken flows
      
      // Allow the attack token as a stablecoin
      await swapContract.allowStableToken(await attackToken.getAddress());
      
      // Fund user with more tokens
      await mockUSDT.mint(user.address, ethers.parseEther("200"));
      await attackToken.mint(user.address, ethers.parseEther("200"));
      
      // Approve tokens for attack purposes
      await mockUSDT.connect(user).approve(await swapContract.getAddress(), ethers.parseEther("200"));
      await attackToken.connect(user).approve(await swapContract.getAddress(), ethers.parseEther("200"));
      
      // Set the attack parameters to attempt calling swapStableTokens(USDT) during transferFrom
      await attackToken.setAttackParameters(user.address, ethers.parseEther("50"));
      
      // Fund the attack token with USDT for its attack
      await mockUSDT.mint(await attackToken.getAddress(), ethers.parseEther("50"));
      await mockUSDT.connect(admin).approve(await swapContract.getAddress(), ethers.parseEther("50"));
      
      // Enable attack mode
      await attackToken.enableAttack();
      
      // Initial main token balance
      const initialBalance = await mainToken.balanceOf(user.address);
      
      // Perform the swap with the attack token
      // During this call, attackToken.transferFrom will be triggered, which attempts to call
      // swapStableTokens again from within the first swapStableTokens call
      await swapContract.connect(user).swapStableTokens(
        await attackToken.getAddress(), 
        ethers.parseEther("100")
      );
      
      // Final main token balance
      const finalBalance = await mainToken.balanceOf(user.address);
      
      // Calculate expected tokens (100 token at $1 = $100, price = 1.1)
      // Expected: $100 / $1.1 = ~90.91 tokens
      const expectedTokens = (ethers.parseEther("100") * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // The difference should match the expected amount (no double-swap happened)
      // If reentrancy protection wasn't working, the user would get more tokens
      expect(finalBalance - initialBalance).to.be.closeTo(
        expectedTokens, 
        ethers.parseEther("0.1") // Allow small rounding error
      );
    });
    
    it("Should test native token to stableToken reentrancy protection", async function() {
      // This test validates that we can't call swapStableTokens from within swapNativeToken
      
      // Deploy the attack receiver contract
      const AttackReceiver = await ethers.getContractFactory("ReentrancyAttackReceiver");
      const attackReceiver = await AttackReceiver.deploy(
        admin.address,
        await swapContract.getAddress(),
        await mockUSDT.getAddress()
      );
      await attackReceiver.deploymentTransaction().wait();
      
      // Fund receiver with USDT for the attack
      await mockUSDT.mint(await attackReceiver.getAddress(), ethers.parseEther("100"));
      
      // Set attack parameters
      await attackReceiver.setAttackAmount(ethers.parseEther("50"));
      
      // Set the funding address to the attack receiver to trigger its receive function
      await swapContract.setFundingAddress(await attackReceiver.getAddress());
      
      // Enable the attack
      await attackReceiver.enableAttack();
      
      // Initial main token balance
      const initialUserTokens = await mainToken.balanceOf(user.address);
      
      // Perform the swap (this will trigger the attack receiver's receive function)
      await swapContract.connect(user).swapNativeToken({
        value: ethers.parseEther("1") 
      });
      
      // Final main token balance
      const finalUserTokens = await mainToken.balanceOf(user.address);
      
      // Calculate expected tokens (for 1 BNB at $300, price = 1.1)
      // Expected: $300 / $1.1 = ~272.73 tokens
      const expectedTokens = (ethers.parseEther("300") * ethers.parseEther("1")) / ethers.parseEther("1.1");
      
      // The difference should match the expected amount (no double-swap happened)
      expect(finalUserTokens - initialUserTokens).to.be.closeTo(
        expectedTokens, 
        ethers.parseEther("0.1") // Allow small rounding error
      );
    });
  });
});