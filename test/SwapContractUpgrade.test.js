const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("SwapContract V1 -> V2 upgrade", function () {
  let admin, funding, user, otherUser;
  let swapContract;
  let mainToken;
  let mockUSDT;
  let secondStable;
  let mockPriceFeed;
  let mockRouter;
  let SwapContractV2Factory;

  const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

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

    // Deploy V1 via proxy.
    const SwapContract = await ethers.getContractFactory("SwapContract");
    swapContract = await upgrades.deployProxy(
      SwapContract,
      [admin.address, funding.address],
      { initializer: "initialize" }
    );
    await swapContract.waitForDeployment();

    // Full configuration on V1.
    await swapContract.setBnbPriceFeed(await mockPriceFeed.getAddress());
    await swapContract.setUsdtAddress(await mockUSDT.getAddress()); // auto-allows USDT
    await swapContract.setSmartRouterAddress(await mockRouter.getAddress());
    await swapContract.allowStableToken(await secondStable.getAddress());

    // Fund the proxy with main token so setMainTokenAddress succeeds.
    await mainToken.mint(await swapContract.getAddress(), ethers.parseEther("1000000"));
    await swapContract.setMainTokenAddress(await mainToken.getAddress());

    // Fund user with stable tokens.
    await mockUSDT.mint(user.address, ethers.parseEther("10000"));

    SwapContractV2Factory = await ethers.getContractFactory("SwapContractV2");
  });

  async function captureSnapshot(contract) {
    const proxyAddress = await contract.getAddress();
    return {
      proxyAddress,
      fundingAddress: await contract.fundingAddress(),
      mainTokenAddress: await contract.mainTokenAddress(),
      mainTokenPriceInUsdt: await contract.mainTokenPriceInUsdt(),
      bnbPriceFeed: await contract.bnbPriceFeed(),
      usdtAddress: await contract.usdtAddress(),
      smartRouterAddress: await contract.smartRouterAddress(),
      adminHasRole: await contract.hasRole(DEFAULT_ADMIN_ROLE, admin.address),
      usdtAllowed: await contract.allowedStableTokens(await mockUSDT.getAddress()),
      secondAllowed: await contract.allowedStableTokens(await secondStable.getAddress()),
      proxyMainTokenBalance: await mainToken.balanceOf(proxyAddress),
    };
  }

  it("Preserves all state through V1 -> V2 upgrade after real swaps", async function () {
    // Execute a real BNB -> main token swap on V1.
    await swapContract
      .connect(user)
      .swapNativeToken({ value: ethers.parseEther("1") });

    // Execute a real stablecoin -> main token swap on V1.
    const usdtAmount = ethers.parseEther("100");
    await mockUSDT.connect(user).approve(await swapContract.getAddress(), usdtAmount);
    await swapContract.connect(user).swapStableTokens(await mockUSDT.getAddress(), usdtAmount);

    // Capture snapshot before upgrade.
    const before = await captureSnapshot(swapContract);

    // Validate storage layout — must not throw.
    await upgrades.validateUpgrade(
      await swapContract.getAddress(),
      SwapContractV2Factory
    );

    // Execute the upgrade.
    const upgraded = await upgrades.upgradeProxy(
      await swapContract.getAddress(),
      SwapContractV2Factory
    );
    await upgraded.waitForDeployment();

    const after = await captureSnapshot(upgraded);

    // Proxy address must not change.
    expect(after.proxyAddress).to.equal(before.proxyAddress);
    // All snapshot fields equal.
    expect(after.fundingAddress).to.equal(before.fundingAddress);
    expect(after.mainTokenAddress).to.equal(before.mainTokenAddress);
    expect(after.mainTokenPriceInUsdt).to.equal(before.mainTokenPriceInUsdt);
    expect(after.bnbPriceFeed).to.equal(before.bnbPriceFeed);
    expect(after.usdtAddress).to.equal(before.usdtAddress);
    expect(after.smartRouterAddress).to.equal(before.smartRouterAddress);
    expect(after.adminHasRole).to.equal(before.adminHasRole);
    expect(after.usdtAllowed).to.equal(before.usdtAllowed);
    expect(after.secondAllowed).to.equal(before.secondAllowed);
    expect(after.proxyMainTokenBalance).to.equal(before.proxyMainTokenBalance);
  });

  it("Allows V1-compatible swapNativeToken calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    // Upgrade first.
    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    expect(await upgraded.getAddress()).to.equal(proxyAddress);

    // V1-signature call still works post-upgrade.
    const bnbAmount = ethers.parseEther("1");
    const expectedUsdt = ethers.parseEther("300");
    const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

    const userMainBefore = await mainToken.balanceOf(user.address);

    await expect(upgraded.connect(user).swapNativeToken({ value: bnbAmount }))
      .to.emit(upgraded, "NativeTokenPurchased")
      .withArgs(user.address, user.address, bnbAmount, expectedUsdt, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    expect(userMainAfter - userMainBefore).to.equal(expectedMain);
  });

  it("Allows V1-compatible swapStableTokens calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    // Upgrade first.
    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    const usdtAmount = ethers.parseEther("100");
    const expectedMain = (usdtAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");

    await mockUSDT.connect(user).approve(proxyAddress, usdtAmount);

    const userMainBefore = await mainToken.balanceOf(user.address);
    const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);

    await expect(upgraded.connect(user).swapStableTokens(await mockUSDT.getAddress(), usdtAmount))
      .to.emit(upgraded, "TokensPurchased")
      .withArgs(user.address, user.address, await mockUSDT.getAddress(), usdtAmount, usdtAmount, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);

    expect(userMainAfter - userMainBefore).to.equal(expectedMain);
    expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(usdtAmount);
  });

  it("Allows V1-compatible swapAnyTokens calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    // Deploy extra non-stable token for this test.
    const MockToken = await ethers.getContractFactory("MockToken");
    const anotherToken = await MockToken.deploy("Another Token", "ATK", 18, admin.address);
    await anotherToken.deploymentTransaction().wait();
    await anotherToken.mint(user.address, ethers.parseEther("10000"));

    // Set up router with exchange rate ATK -> USDT = 2.
    const atkAddress = await anotherToken.getAddress();
    const usdtAddress = await mockUSDT.getAddress();
    await mockRouter.setExchangeRate(atkAddress, usdtAddress, 2);
    // Fund router with USDT so it can deliver to funding address.
    await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));

    // Upgrade.
    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    const tokenAmount = ethers.parseEther("100");
    const path = [atkAddress, usdtAddress];
    const expectedUsdt = ethers.parseEther("200"); // 100 ATK * 2 = 200 USDT
    const minAmountOut = (expectedUsdt * 95n) / 100n;
    const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

    await anotherToken.connect(user).approve(proxyAddress, tokenAmount);

    const swapInterface = new ethers.Interface([
      "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
    ]);
    const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
      tokenAmount,
      minAmountOut,
      path,
      funding.address
    ]);

    const userMainBefore = await mainToken.balanceOf(user.address);
    const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);

    await expect(upgraded.connect(user).swapAnyTokens(atkAddress, tokenAmount, swapCalldata))
      .to.emit(upgraded, "TokensPurchased")
      .withArgs(user.address, user.address, atkAddress, tokenAmount, expectedUsdt, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);

    expect(userMainAfter - userMainBefore).to.equal(expectedMain);
    expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(expectedUsdt);
  });

  it("Allows new swapNativeTokenTo calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    const bnbAmount = ethers.parseEther("1");
    const expectedUsdt = ethers.parseEther("300");
    const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

    const userMainBefore = await mainToken.balanceOf(user.address);
    const otherUserMainBefore = await mainToken.balanceOf(otherUser.address);
    const fundingBnbBefore = await ethers.provider.getBalance(funding.address);

    await expect(upgraded.connect(user).swapNativeTokenTo(otherUser.address, { value: bnbAmount }))
      .to.emit(upgraded, "NativeTokenPurchased")
      .withArgs(user.address, otherUser.address, bnbAmount, expectedUsdt, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    const otherUserMainAfter = await mainToken.balanceOf(otherUser.address);
    const fundingBnbAfter = await ethers.provider.getBalance(funding.address);

    // Recipient is otherUser, not user.
    expect(otherUserMainAfter - otherUserMainBefore).to.equal(expectedMain);
    expect(userMainAfter - userMainBefore).to.equal(0n);
    // Funding received BNB.
    expect(fundingBnbAfter - fundingBnbBefore).to.equal(bnbAmount);
  });

  it("Allows new swapStableTokensTo calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    const usdtAmount = ethers.parseEther("100");
    const expectedMain = (usdtAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");

    await mockUSDT.connect(user).approve(proxyAddress, usdtAmount);

    const userMainBefore = await mainToken.balanceOf(user.address);
    const otherUserMainBefore = await mainToken.balanceOf(otherUser.address);
    const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);

    await expect(
      upgraded.connect(user).swapStableTokensTo(otherUser.address, await mockUSDT.getAddress(), usdtAmount)
    )
      .to.emit(upgraded, "TokensPurchased")
      .withArgs(user.address, otherUser.address, await mockUSDT.getAddress(), usdtAmount, usdtAmount, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    const otherUserMainAfter = await mainToken.balanceOf(otherUser.address);
    const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);

    expect(otherUserMainAfter - otherUserMainBefore).to.equal(expectedMain);
    expect(userMainAfter - userMainBefore).to.equal(0n);
    expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(usdtAmount);
  });

  it("Allows new swapAnyTokensTo calls after upgrade", async function () {
    const proxyAddress = await swapContract.getAddress();

    // Deploy extra non-stable token.
    const MockToken = await ethers.getContractFactory("MockToken");
    const anotherToken = await MockToken.deploy("Another Token", "ATK", 18, admin.address);
    await anotherToken.deploymentTransaction().wait();
    await anotherToken.mint(user.address, ethers.parseEther("10000"));

    const atkAddress = await anotherToken.getAddress();
    const usdtAddress = await mockUSDT.getAddress();
    await mockRouter.setExchangeRate(atkAddress, usdtAddress, 2);
    await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));

    const upgraded = await upgrades.upgradeProxy(proxyAddress, SwapContractV2Factory);
    await upgraded.waitForDeployment();

    const tokenAmount = ethers.parseEther("100");
    const path = [atkAddress, usdtAddress];
    const expectedUsdt = ethers.parseEther("200");
    const minAmountOut = (expectedUsdt * 95n) / 100n;
    const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

    await anotherToken.connect(user).approve(proxyAddress, tokenAmount);

    const swapInterface = new ethers.Interface([
      "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
    ]);
    const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
      tokenAmount,
      minAmountOut,
      path,
      funding.address
    ]);

    const userMainBefore = await mainToken.balanceOf(user.address);
    const otherUserMainBefore = await mainToken.balanceOf(otherUser.address);
    const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);

    await expect(
      upgraded.connect(user).swapAnyTokensTo(otherUser.address, atkAddress, tokenAmount, swapCalldata)
    )
      .to.emit(upgraded, "TokensPurchased")
      .withArgs(user.address, otherUser.address, atkAddress, tokenAmount, expectedUsdt, expectedMain);

    const userMainAfter = await mainToken.balanceOf(user.address);
    const otherUserMainAfter = await mainToken.balanceOf(otherUser.address);
    const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);

    expect(otherUserMainAfter - otherUserMainBefore).to.equal(expectedMain);
    expect(userMainAfter - userMainBefore).to.equal(0n);
    expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(expectedUsdt);
  });
});
