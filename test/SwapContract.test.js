const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SwapContract", function () {
  let swapContract;
  let mainToken;
  let mockUSDT;
  let mockPriceFeed;
  let mockRouter;
  let admin;
  let funding;
  let user;

  beforeEach(async function () {
    // Get signers
    [admin, funding, user, mockRouter] = await ethers.getSigners();
    
    // Deploy mock tokens for testing
    const MockToken = await ethers.getContractFactory("MockToken");
    
    // Deploy mock USDT token
    mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 18, admin.address);
    await mockUSDT.deploymentTransaction().wait();
    
    // Deploy main token
    mainToken = await MockToken.deploy("Bobe Token", "BOBE", 18, admin.address);
    await mainToken.deploymentTransaction().wait();
    
    // Deploy mock price feed
    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    mockPriceFeed = await MockV3Aggregator.deploy(8, 30000000000); // 8 decimals, $300 BNB price
    await mockPriceFeed.deploymentTransaction().wait();
    
    // Deploy the SwapContract
    const SwapContract = await ethers.getContractFactory("SwapContract");
    swapContract = await SwapContract.deploy();
    await swapContract.deploymentTransaction().wait();
    
    // Initialize the SwapContract
    await swapContract.initialize(admin.address, funding.address);
    
    // Set required addresses
    await swapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
    await swapContract.setUsdtAddress(await mockUSDT.getAddress());
    await swapContract.setSmartRouterAddress(mockRouter.address);
    
    // Allow USDT as a stablecoin
    await swapContract.allowStableToken(await mockUSDT.getAddress());
    
    // Transfer tokens to the contract
    await mainToken.mint(await swapContract.getAddress(), ethers.parseEther("1000000"));
    
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
      expect(await swapContract.smartRouterAddress()).to.equal(mockRouter.address);
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
      await newSwapContract.setSmartRouterAddress(mockRouter.address);
      
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
});