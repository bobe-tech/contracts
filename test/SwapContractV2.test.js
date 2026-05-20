const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("SwapContractV2", function () {
  let swap;
  let mainToken;
  let mockUSDT;
  let mockPriceFeed;
  let mockRouter;
  let anotherToken;
  let admin;
  let funding;
  let user;
  let recipient;
  let otherUser;

  beforeEach(async function () {
    [admin, funding, user, recipient, otherUser] = await ethers.getSigners();

    const MockToken = await ethers.getContractFactory("MockToken");

    mockUSDT = await MockToken.deploy("Mock USDT", "USDT", 18, admin.address);
    await mockUSDT.deploymentTransaction().wait();

    mainToken = await MockToken.deploy("Bobe Token", "BOBE", 18, admin.address);
    await mainToken.deploymentTransaction().wait();

    anotherToken = await MockToken.deploy("Another Token", "ATK", 18, admin.address);
    await anotherToken.deploymentTransaction().wait();

    const MockV3Aggregator = await ethers.getContractFactory("MockV3Aggregator");
    mockPriceFeed = await MockV3Aggregator.deploy(8, 30000000000); // $300 BNB
    await mockPriceFeed.deploymentTransaction().wait();

    const MockPancakeRouter = await ethers.getContractFactory("MockPancakeRouter");
    mockRouter = await MockPancakeRouter.deploy(await mockUSDT.getAddress());
    await mockRouter.deploymentTransaction().wait();

    const SwapContractV2 = await ethers.getContractFactory("SwapContractV2");
    swap = await upgrades.deployProxy(
      SwapContractV2,
      [admin.address, funding.address],
      { initializer: "initialize" }
    );
    await swap.waitForDeployment();

    await swap.setBnbPriceFeed(await mockPriceFeed.getAddress());
    await swap.setUsdtAddress(await mockUSDT.getAddress());
    await swap.setSmartRouterAddress(await mockRouter.getAddress());

    await mainToken.mint(await swap.getAddress(), ethers.parseEther("1000000"));
    await mockUSDT.mint(user.address, ethers.parseEther("10000"));
    await anotherToken.mint(user.address, ethers.parseEther("10000"));

    await swap.setMainTokenAddress(await mainToken.getAddress());
  });

  describe("swapNativeTokenTo", function () {
    it("sends main token to explicit recipient and BNB to funding", async function () {
      const bnbAmount = ethers.parseEther("1");
      const expectedUsdt = ethers.parseEther("300");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

      const recipientMainBefore = await mainToken.balanceOf(recipient.address);
      const userMainBefore = await mainToken.balanceOf(user.address);
      const fundingBnbBefore = await ethers.provider.getBalance(funding.address);

      await expect(swap.connect(user).swapNativeTokenTo(recipient.address, { value: bnbAmount }))
        .to.emit(swap, "NativeTokenPurchased")
        .withArgs(user.address, recipient.address, bnbAmount, expectedUsdt, expectedMain);

      const recipientMainAfter = await mainToken.balanceOf(recipient.address);
      const userMainAfter = await mainToken.balanceOf(user.address);
      const fundingBnbAfter = await ethers.provider.getBalance(funding.address);

      expect(recipientMainAfter - recipientMainBefore).to.equal(expectedMain);
      expect(userMainAfter - userMainBefore).to.equal(0n);
      expect(fundingBnbAfter - fundingBnbBefore).to.equal(bnbAmount);
    });

    it("reverts on zero recipient", async function () {
      await expect(
        swap.connect(user).swapNativeTokenTo(ethers.ZeroAddress, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Recipient cannot be zero address");
    });

    it("reverts on zero BNB amount", async function () {
      await expect(
        swap.connect(user).swapNativeTokenTo(recipient.address, { value: 0 })
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("reverts when main token is not initialized", async function () {
      const SwapContractV2 = await ethers.getContractFactory("SwapContractV2");
      const fresh = await upgrades.deployProxy(
        SwapContractV2,
        [admin.address, funding.address],
        { initializer: "initialize" }
      );
      await fresh.waitForDeployment();
      await fresh.setBnbPriceFeed(await mockPriceFeed.getAddress());

      await expect(
        fresh.connect(user).swapNativeTokenTo(recipient.address, { value: ethers.parseEther("1") })
      ).to.be.revertedWith("Main token address must be set first");
    });
  });

  describe("swapStableTokensTo", function () {
    it("sends main token to recipient and stablecoin to funding", async function () {
      const usdtAmount = ethers.parseEther("100");
      const expectedMain = (usdtAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");

      await mockUSDT.connect(user).approve(await swap.getAddress(), usdtAmount);

      const recipientMainBefore = await mainToken.balanceOf(recipient.address);
      const fundingUsdtBefore = await mockUSDT.balanceOf(funding.address);

      await expect(
        swap.connect(user).swapStableTokensTo(recipient.address, await mockUSDT.getAddress(), usdtAmount)
      )
        .to.emit(swap, "TokensPurchased")
        .withArgs(
          user.address,
          recipient.address,
          await mockUSDT.getAddress(),
          usdtAmount,
          usdtAmount,
          expectedMain
        );

      const recipientMainAfter = await mainToken.balanceOf(recipient.address);
      const fundingUsdtAfter = await mockUSDT.balanceOf(funding.address);

      expect(recipientMainAfter - recipientMainBefore).to.equal(expectedMain);
      expect(fundingUsdtAfter - fundingUsdtBefore).to.equal(usdtAmount);
    });

    it("reverts on zero recipient", async function () {
      await expect(
        swap.connect(user).swapStableTokensTo(
          ethers.ZeroAddress,
          await mockUSDT.getAddress(),
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Recipient cannot be zero address");
    });

    it("reverts on non-allowed token", async function () {
      await expect(
        swap.connect(user).swapStableTokensTo(
          recipient.address,
          await anotherToken.getAddress(),
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Token not allowed");
    });

    it("reverts on zero amount", async function () {
      await expect(
        swap.connect(user).swapStableTokensTo(
          recipient.address,
          await mockUSDT.getAddress(),
          0
        )
      ).to.be.revertedWith("Amount must be greater than 0");
    });
  });

  describe("swapAnyTokensTo", function () {
    beforeEach(async function () {
      // Mock router: 1 ATK -> 2 USDT.
      await mockRouter.setExchangeRate(
        await anotherToken.getAddress(),
        await mockUSDT.getAddress(),
        2
      );
      await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));
    });

    it("sends main token to recipient after router swap", async function () {
      const tokenAmount = ethers.parseEther("100");
      const expectedUsdt = ethers.parseEther("200");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

      await anotherToken.connect(user).approve(await swap.getAddress(), tokenAmount);

      const minAmountOut = (expectedUsdt * 95n) / 100n;
      const path = [await anotherToken.getAddress(), await mockUSDT.getAddress()];

      const swapInterface = new ethers.Interface([
        "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
      ]);
      const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
        tokenAmount,
        minAmountOut,
        path,
        funding.address,
      ]);

      const recipientMainBefore = await mainToken.balanceOf(recipient.address);

      await expect(
        swap.connect(user).swapAnyTokensTo(
          recipient.address,
          await anotherToken.getAddress(),
          tokenAmount,
          swapCalldata
        )
      )
        .to.emit(swap, "TokensPurchased")
        .withArgs(
          user.address,
          recipient.address,
          await anotherToken.getAddress(),
          tokenAmount,
          expectedUsdt,
          expectedMain
        );

      const recipientMainAfter = await mainToken.balanceOf(recipient.address);
      expect(recipientMainAfter - recipientMainBefore).to.be.closeTo(expectedMain, ethers.parseEther("0.01"));
    });

    it("reverts on zero recipient", async function () {
      await expect(
        swap.connect(user).swapAnyTokensTo(
          ethers.ZeroAddress,
          await anotherToken.getAddress(),
          ethers.parseEther("100"),
          "0x"
        )
      ).to.be.revertedWith("Recipient cannot be zero address");
    });

    it("reverts when tokenIn is a stable token", async function () {
      await expect(
        swap.connect(user).swapAnyTokensTo(
          recipient.address,
          await mockUSDT.getAddress(),
          ethers.parseEther("100"),
          "0x"
        )
      ).to.be.revertedWith("Use swapStableTokens for stablecoins");
    });
  });

  describe("Regression: V1-signature functions with expanded events", function () {
    it("swapNativeToken emits payer==recipient and delivers to msg.sender", async function () {
      const bnbAmount = ethers.parseEther("1");
      const expectedUsdt = ethers.parseEther("300");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

      const userMainBefore = await mainToken.balanceOf(user.address);

      await expect(swap.connect(user).swapNativeToken({ value: bnbAmount }))
        .to.emit(swap, "NativeTokenPurchased")
        .withArgs(user.address, user.address, bnbAmount, expectedUsdt, expectedMain);

      const userMainAfter = await mainToken.balanceOf(user.address);
      expect(userMainAfter - userMainBefore).to.equal(expectedMain);
    });

    it("swapStableTokens emits payer==recipient and delivers to msg.sender", async function () {
      const usdtAmount = ethers.parseEther("100");
      const expectedMain = (usdtAmount * ethers.parseEther("1")) / ethers.parseEther("1.1");

      await mockUSDT.connect(user).approve(await swap.getAddress(), usdtAmount);

      const userMainBefore = await mainToken.balanceOf(user.address);

      await expect(swap.connect(user).swapStableTokens(await mockUSDT.getAddress(), usdtAmount))
        .to.emit(swap, "TokensPurchased")
        .withArgs(
          user.address,
          user.address,
          await mockUSDT.getAddress(),
          usdtAmount,
          usdtAmount,
          expectedMain
        );

      const userMainAfter = await mainToken.balanceOf(user.address);
      expect(userMainAfter - userMainBefore).to.equal(expectedMain);
    });

    it("swapAnyTokens emits payer==recipient and delivers to msg.sender", async function () {
      // Router setup.
      await mockRouter.setExchangeRate(
        await anotherToken.getAddress(),
        await mockUSDT.getAddress(),
        2
      );
      await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));

      const tokenAmount = ethers.parseEther("100");
      const expectedUsdt = ethers.parseEther("200");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");

      await anotherToken.connect(user).approve(await swap.getAddress(), tokenAmount);

      const minAmountOut = (expectedUsdt * 95n) / 100n;
      const path = [await anotherToken.getAddress(), await mockUSDT.getAddress()];
      const swapInterface = new ethers.Interface([
        "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
      ]);
      const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
        tokenAmount,
        minAmountOut,
        path,
        funding.address,
      ]);

      const userMainBefore = await mainToken.balanceOf(user.address);

      await expect(
        swap.connect(user).swapAnyTokens(await anotherToken.getAddress(), tokenAmount, swapCalldata)
      )
        .to.emit(swap, "TokensPurchased")
        .withArgs(
          user.address,
          user.address,
          await anotherToken.getAddress(),
          tokenAmount,
          expectedUsdt,
          expectedMain
        );

      const userMainAfter = await mainToken.balanceOf(user.address);
      expect(userMainAfter - userMainBefore).to.be.closeTo(expectedMain, ethers.parseEther("0.01"));
    });
  });

  describe("swapAnyTokens with msg.value > 0 (native fee forwarding)", function () {
    // Smoke-test: swapAnyTokens is payable and forwards msg.value to the router
    // via `.call{value: msg.value}(swapCalldata)`. Verifies:
    //  - call does not revert with non-zero msg.value;
    //  - mainToken delivered to recipient (end-to-end state correct);
    //  - BNB transferred from user to router (pass-through).
    //
    // MockPancakeRouter is payable and accepts native without returning —
    // sufficient to cover the payable signature and the happy path.
    beforeEach(async function () {
      await mockRouter.setExchangeRate(
        await anotherToken.getAddress(),
        await mockUSDT.getAddress(),
        2
      );
      await mockUSDT.mint(await mockRouter.getAddress(), ethers.parseEther("10000"));
    });

    it("swapAnyTokens forwards msg.value to the router and delivers main token", async function () {
      const tokenAmount = ethers.parseEther("100");
      const expectedUsdt = ethers.parseEther("200");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");
      const nativeFee = ethers.parseEther("0.01");

      await anotherToken.connect(user).approve(await swap.getAddress(), tokenAmount);

      const minAmountOut = (expectedUsdt * 95n) / 100n;
      const path = [await anotherToken.getAddress(), await mockUSDT.getAddress()];
      const swapInterface = new ethers.Interface([
        "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
      ]);
      const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
        tokenAmount,
        minAmountOut,
        path,
        funding.address,
      ]);

      const routerBnbBefore = await ethers.provider.getBalance(await mockRouter.getAddress());
      const userMainBefore = await mainToken.balanceOf(user.address);

      await expect(
        swap
          .connect(user)
          .swapAnyTokens(await anotherToken.getAddress(), tokenAmount, swapCalldata, { value: nativeFee })
      ).to.emit(swap, "TokensPurchased");

      const routerBnbAfter = await ethers.provider.getBalance(await mockRouter.getAddress());
      const userMainAfter = await mainToken.balanceOf(user.address);

      // Router received native value (pass-through).
      expect(routerBnbAfter - routerBnbBefore).to.equal(nativeFee);
      // Main token delivered to msg.sender (V1-signature).
      expect(userMainAfter - userMainBefore).to.be.closeTo(expectedMain, ethers.parseEther("0.01"));
    });

    it("swapAnyTokensTo forwards msg.value and delivers main token to explicit recipient", async function () {
      const tokenAmount = ethers.parseEther("100");
      const expectedUsdt = ethers.parseEther("200");
      const expectedMain = (expectedUsdt * ethers.parseEther("1")) / ethers.parseEther("1.1");
      const nativeFee = ethers.parseEther("0.005");

      await anotherToken.connect(user).approve(await swap.getAddress(), tokenAmount);

      const minAmountOut = (expectedUsdt * 95n) / 100n;
      const path = [await anotherToken.getAddress(), await mockUSDT.getAddress()];
      const swapInterface = new ethers.Interface([
        "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to) external payable returns (uint256 amountOut)"
      ]);
      const swapCalldata = swapInterface.encodeFunctionData("swapExactTokensForTokens", [
        tokenAmount,
        minAmountOut,
        path,
        funding.address,
      ]);

      const routerBnbBefore = await ethers.provider.getBalance(await mockRouter.getAddress());
      const recipientMainBefore = await mainToken.balanceOf(recipient.address);

      await expect(
        swap
          .connect(user)
          .swapAnyTokensTo(
            recipient.address,
            await anotherToken.getAddress(),
            tokenAmount,
            swapCalldata,
            { value: nativeFee }
          )
      ).to.emit(swap, "TokensPurchased");

      const routerBnbAfter = await ethers.provider.getBalance(await mockRouter.getAddress());
      const recipientMainAfter = await mainToken.balanceOf(recipient.address);

      expect(routerBnbAfter - routerBnbBefore).to.equal(nativeFee);
      expect(recipientMainAfter - recipientMainBefore).to.be.closeTo(expectedMain, ethers.parseEther("0.01"));
    });
  });
});
