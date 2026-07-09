const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("SwapContract V2 -> V3 upgrade (setMainTokenPrice)", function () {
  let admin, funding, user, otherUser;
  let swapContract; // proxy, currently on V2
  let mainToken;
  let mockUSDT;
  let secondStable;
  let mockPriceFeed;
  let mockRouter;
  let SwapContractV3Factory;

  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const NEW_PRICE = ethers.parseEther("1.15"); // 1.15 USDT, 18 decimals

  beforeEach(async function () {
    [admin, funding, user, otherUser] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");

    mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 18, admin.address);
    await mockUSDT.deploymentTransaction().wait();

    secondStable = await MockToken.deploy("Second Stable", "SSTBL", 18, admin.address);
    await secondStable.deploymentTransaction().wait();

    mainToken = await MockToken.deploy("Bobe Token", "BOBE", 18, admin.address);
    await mainToken.deploymentTransaction().wait();

    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    mockPriceFeed = await MockV3Aggregator.deploy(8, 30000000000); // $300 BNB
    await mockPriceFeed.deploymentTransaction().wait();

    const MockPancakeRouter = await ethers.getContractFactory("MockPancakeRouter");
    mockRouter = await MockPancakeRouter.deploy(await mockUSDT.getAddress());
    await mockRouter.deploymentTransaction().wait();

    // Deploy V1 via proxy, then upgrade to V2 — reproduce the real on-chain state
    // (dev/stage/prod are all already on V2 before this upgrade).
    const SwapContract = await ethers.getContractFactory("SwapContract");
    swapContract = await upgrades.deployProxy(
      SwapContract,
      [admin.address, funding.address],
      { initializer: "initialize" }
    );
    await swapContract.waitForDeployment();

    await swapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
    await swapContract.setUsdtAddress(await mockUSDT.getAddress()); // auto-allows USDT
    await swapContract.setSmartRouterAddress(await mockRouter.getAddress());
    await swapContract.allowStableToken(await secondStable.getAddress());

    await mainToken.mint(await swapContract.getAddress(), ethers.parseEther("1000000"));
    await swapContract.setMainTokenAddress(await mainToken.getAddress());

    await mockUSDT.mint(user.address, ethers.parseEther("10000"));

    // Upgrade to V2 (starting point for this V3 upgrade).
    const SwapContractV2Factory = await ethers.getContractFactory("SwapContractV2");
    swapContract = await upgrades.upgradeProxy(await swapContract.getAddress(), SwapContractV2Factory);
    await swapContract.waitForDeployment();

    SwapContractV3Factory = await ethers.getContractFactory("SwapContractV3");
  });

  it("Validates storage layout V2 -> V3", async function () {
    await upgrades.validateUpgrade(
      await swapContract.getAddress(),
      SwapContractV3Factory
    );
  });

  it("Preserves price and state through V2 -> V3 upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();
    const priceBefore = await swapContract.mainTokenPriceInUsdt();
    expect(priceBefore).to.equal(ethers.parseEther("1.1"));

    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV3Factory);
    await upgraded.waitForDeployment();

    expect(await upgraded.getAddress()).to.equal(proxyAddress);
    expect(await upgraded.mainTokenPriceInUsdt()).to.equal(priceBefore);
    expect(await upgraded.fundingAddress()).to.equal(funding.address);
    expect(await upgraded.mainTokenAddress()).to.equal(await mainToken.getAddress());
    expect(await upgraded.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true);
  });

  it("Admin can update the price and event is emitted", async function () {
    const upgraded = await upgrades.upgradeProxy(await swapContract.getAddress(), SwapContractV3Factory);
    await upgraded.waitForDeployment();

    const oldPrice = await upgraded.mainTokenPriceInUsdt();

    await expect(upgraded.connect(admin).setMainTokenPrice(NEW_PRICE))
      .to.emit(upgraded, "MainTokenPriceUpdated")
      .withArgs(oldPrice, NEW_PRICE);

    expect(await upgraded.mainTokenPriceInUsdt()).to.equal(NEW_PRICE);
  });

  it("Non-admin cannot update the price", async function () {
    const upgraded = await upgrades.upgradeProxy(await swapContract.getAddress(), SwapContractV3Factory);
    await upgraded.waitForDeployment();

    await expect(
      upgraded.connect(user).setMainTokenPrice(NEW_PRICE)
    ).to.be.reverted;

    expect(await upgraded.mainTokenPriceInUsdt()).to.equal(ethers.parseEther("1.1"));
  });

  it("Rejects zero price", async function () {
    const upgraded = await upgrades.upgradeProxy(await swapContract.getAddress(), SwapContractV3Factory);
    await upgraded.waitForDeployment();

    await expect(
      upgraded.connect(admin).setMainTokenPrice(0)
    ).to.be.revertedWith("Price must be greater than 0");
  });

  it("New price is actually applied in swaps", async function () {
    const proxyAddress = await swapContract.getAddress();
    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV3Factory);
    await upgraded.waitForDeployment();

    // Change price to 1.15 USDT.
    await upgraded.connect(admin).setMainTokenPrice(NEW_PRICE);

    // A stablecoin swap must now use the new price.
    const usdtAmount = ethers.parseEther("115");
    const expectedMain = (usdtAmount * ethers.parseEther("1")) / NEW_PRICE; // = 100 tokens

    await mockUSDT.connect(user).approve(proxyAddress, usdtAmount);

    const userMainBefore = await mainToken.balanceOf(user.address);
    await expect(upgraded.connect(user).swapStableTokens(await mockUSDT.getAddress(), usdtAmount))
      .to.emit(upgraded, "TokensPurchased")
      .withArgs(user.address, user.address, await mockUSDT.getAddress(), usdtAmount, usdtAmount, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    expect(userMainAfter - userMainBefore).to.equal(expectedMain);
    expect(expectedMain).to.equal(ethers.parseEther("100"));
  });

  it("Keeps V2 swap functions working after V3 upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();
    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV3Factory);
    await upgraded.waitForDeployment();

    // recipient-aware V2 call still works on V3.
    const bnbAmount = ethers.parseEther("1");
    const expectedUsdt = ethers.parseEther("300");
    const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

    const otherUserMainBefore = await mainToken.balanceOf(otherUser.address);
    await expect(upgraded.connect(user).swapNativeTokenTo(otherUser.address, { value: bnbAmount }))
      .to.emit(upgraded, "NativeTokenPurchased")
      .withArgs(user.address, otherUser.address, bnbAmount, expectedUsdt, expectedMain);

    const otherUserMainAfter = await mainToken.balanceOf(otherUser.address);
    expect(otherUserMainAfter - otherUserMainBefore).to.equal(expectedMain);
  });
});
