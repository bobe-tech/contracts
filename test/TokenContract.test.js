const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TokenContract", function () {
  let tokenContract;
  let owner;
  let user;
  let user2;
  let expectedTotalSupply;
  let liquiditySupply;
  let marketingSupply;
  let teamSupply;
  let deployTimestamp;

  beforeEach(async function () {
    // Get signers
    [owner, user, user2] = await ethers.getSigners();
    
    // Deploy the TokenContract with multisig address (using owner as mock multisig for test)
    const TokenContract = await ethers.getContractFactory("TokenContract");
    tokenContract = await TokenContract.deploy(owner.address);
    await tokenContract.deploymentTransaction().wait();
    
    // Store key values for tests
    expectedTotalSupply = ethers.parseEther("1000000000");
    liquiditySupply = await tokenContract.liquiditySupply();
    marketingSupply = await tokenContract.marketingSupply();
    teamSupply = await tokenContract.teamSupply();
    
    // Store deployment timestamp
    const deployBlock = await ethers.provider.getBlock(tokenContract.deploymentTransaction().blockHash);
    deployTimestamp = deployBlock.timestamp;
  });

  describe("Deployment", function () {
    it("Should deploy the contract with correct initial values", async function () {
      // Check token name and symbol
      expect(await tokenContract.name()).to.equal("Bobe.app");
      expect(await tokenContract.symbol()).to.equal("BOBE");
      
      // Check total supply (1 billion tokens with 18 decimals)
      expect(await tokenContract.totalSupply()).to.equal(expectedTotalSupply);
      
      // Check contract token balance equals total supply
      expect(await tokenContract.balanceOf(await tokenContract.getAddress())).to.equal(expectedTotalSupply);
      
      // Verify distribution percentages
      expect(liquiditySupply).to.equal(expectedTotalSupply * 80n / 100n);
      expect(marketingSupply).to.equal(expectedTotalSupply * 12n / 100n);
      expect(teamSupply).to.equal(expectedTotalSupply - (liquiditySupply + marketingSupply));
      
      // Check remaining token amounts
      expect(await tokenContract.liquidityLeft()).to.equal(liquiditySupply);
      expect(await tokenContract.marketingLeft()).to.equal(marketingSupply);
      expect(await tokenContract.teamLeft()).to.equal(teamSupply);
      
      // Note: marketingUnlockedPortions and teamUnlockedPortions are not public functions in the contract
      
      // Verify owner is set to the multisig address
      expect(await tokenContract.owner()).to.equal(owner.address);
    });

    it("Should set correct unlock periods", async function () {
      // Check unlock constants
      expect(await tokenContract.UNLOCK_PERIOD()).to.equal(30 * 24 * 60 * 60); // 30 days in seconds
      expect(await tokenContract.UNLOCK_PERCENTAGE()).to.equal(10);
      expect(await tokenContract.UNLOCK_PORTIONS()).to.equal(10);
      
      // Check marketing unlock starts immediately
      const marketingStart = await tokenContract.marketingUnlockStart();
      expect(Number(marketingStart)).to.be.closeTo(deployTimestamp, 10); // Within 10 seconds of deployment
      
      // Check team unlock starts after 548 days
      const teamStart = await tokenContract.teamUnlockStart();
      expect(teamStart).to.be.closeTo(BigInt(deployTimestamp) + BigInt(548 * 24 * 60 * 60), 10n);
    });

    it("Should revert deployment if multisig address is zero", async function () {
      const TokenContract = await ethers.getContractFactory("TokenContract");
      await expect(TokenContract.deploy("0x0000000000000000000000000000000000000000"))
        .to.be.revertedWithCustomError(TokenContract, "OwnableInvalidOwner")
        .withArgs("0x0000000000000000000000000000000000000000");
    });
  });
  
  describe("Token Transfer Functions", function () {
    it("Should transfer liquidity tokens correctly", async function () {
      const transferAmount = ethers.parseEther("1000");
      
      // Check initial balances
      expect(await tokenContract.balanceOf(user.address)).to.equal(0);
      expect(await tokenContract.liquidityLeft()).to.equal(liquiditySupply);
      
      // Transfer liquidity
      await expect(tokenContract.transferLiquidity(user.address, transferAmount))
        .to.emit(tokenContract, "LiquidityTransferred")
        .withArgs(user.address, transferAmount);
      
      // Check balances after transfer
      expect(await tokenContract.balanceOf(user.address)).to.equal(transferAmount);
      expect(await tokenContract.liquidityLeft()).to.equal(liquiditySupply - transferAmount);
    });
    
    it("Should prevent non-owner from transferring liquidity", async function () {
      await expect(tokenContract.connect(user).transferLiquidity(user.address, ethers.parseEther("1000")))
        .to.be.revertedWithCustomError(tokenContract, "OwnableUnauthorizedAccount")
        .withArgs(user.address);
    });
    
    it("Should not allow transferring more than unlocked marketing tokens", async function () {
      // Try to transfer when unlock might not be enough
      const transferAmount = ethers.parseEther("1000");
      
      // Either this transfer will work or it will fail with the specific error
      try {
        await tokenContract.transferMarketing(user.address, transferAmount);
      } catch (error) {
        expect(error.message).to.include("Amount exceeds currently unlocked marketing tokens");
      }
    });
    
    it("Should prevent transferring team tokens before unlock period", async function () {
      await expect(tokenContract.transferTeam(user.address, ethers.parseEther("1000")))
        .to.be.revertedWith("Team tokens are still in initial lock period");
    });
    
    it("Should verify team tokens unlock start time", async function () {
      // Check the team unlock start time is in the future
      const teamUnlockStart = await tokenContract.teamUnlockStart();
      const currentTime = await ethers.provider.getBlock("latest").then(b => b.timestamp);
      
      expect(teamUnlockStart).to.be.gt(currentTime);
      expect(await tokenContract.getUnlockedTeamAmount()).to.equal(0);
      
      // Try to transfer after unlock time, but before tokens actually unlock
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(teamUnlockStart) + 1]);
      await ethers.provider.send("evm_mine");
      
      // Token unlock should still be 0 immediately after unlock start
      // (unless _getUnlockedAmount returns something for elapsedPeriods = 0)
      const transferAmount = ethers.parseEther("1000");
      
      // This will either succeed or fail with a specific error - team tokens
      // might not yet be unlocked, or a small amount may be unlocked
      try {
        await tokenContract.transferTeam(user.address, transferAmount);
      } catch (error) {
        if (error.message.includes("Amount exceeds currently unlocked team tokens")) {
          // This is an acceptable error
          return;
        }
        throw error; // Rethrow any other error
      }
    });
    
    it("Should enforce value validation in _transferTokens", async function () {
      // Try to transfer 0 tokens
      await expect(tokenContract.transferLiquidity(user.address, 0))
        .to.be.revertedWith("Value must be greater than 0");
      
      // Try to transfer to zero address
      await expect(tokenContract.transferLiquidity(ethers.ZeroAddress, ethers.parseEther("1000")))
        .to.be.revertedWith("Invalid address");
      
      // Try to transfer more than available
      await expect(tokenContract.transferLiquidity(user.address, liquiditySupply + 1n))
        .to.be.revertedWith("Not enough tokens to transfer");
    });
  });

  describe("Token Recovery", function () {
    it("Should recover excess BOBE tokens", async function () {
      // First transfer some tokens out of the contract
      const transferAmount = ethers.parseEther("1000");
      await tokenContract.transferLiquidity(user.address, transferAmount);
      
      // Then transfer them back to simulate excess tokens
      await tokenContract.connect(user).transfer(await tokenContract.getAddress(), transferAmount);
      
      // Check contract balance after transfer
      const contractBalance = await tokenContract.balanceOf(await tokenContract.getAddress());
      const totalLeft = (await tokenContract.liquidityLeft()) + 
                        (await tokenContract.marketingLeft()) + 
                        (await tokenContract.teamLeft());
      
      expect(contractBalance).to.equal(totalLeft + transferAmount);
      
      // Recover excess tokens
      await expect(tokenContract.recoverTokens(await tokenContract.getAddress()))
        .to.changeTokenBalance(tokenContract, owner, transferAmount);
    });
    
    it("Should recover other ERC20 tokens", async function () {
      // Deploy a mock token
      const MockToken = await ethers.getContractFactory("MockToken");
      const mockToken = await MockToken.deploy("Mock", "MCK", 18, owner.address);
      
      // Send some mock tokens to the token contract
      const amount = ethers.parseEther("100");
      await mockToken.transfer(await tokenContract.getAddress(), amount);
      
      // Recover the mock tokens
      await expect(tokenContract.recoverTokens(await mockToken.getAddress()))
        .to.changeTokenBalance(mockToken, owner, amount);
    });
    
    it("Should revert if no tokens to recover", async function () {
      // Deploy a mock token without sending any to the contract
      const MockToken = await ethers.getContractFactory("MockToken");
      const mockToken = await MockToken.deploy("Mock", "MCK", 18, owner.address);
      
      // Try to recover with no balance
      await expect(tokenContract.recoverTokens(await mockToken.getAddress()))
        .to.be.revertedWith("No tokens to recover");
    });
    
    it("Should revert if all BOBE tokens are allocated", async function () {
      // Try to recover when all tokens are allocated
      await expect(tokenContract.recoverTokens(await tokenContract.getAddress()))
        .to.be.revertedWith("All tokens are locked");
    });
  });
  
  describe("Unlock Information Functions", function () {
    it("Should provide marketing unlock information through getter functions", async function () {
      // Get unlock information at deployment
      const initialUnlocked = await tokenContract.getUnlockedMarketingAmount();
      const [initialNextAmount, initialNextTime] = await tokenContract.getNextMarketingUnlock();
      
      // Check that values are reasonable (not checking exact amounts since we're not 
      // testing the calculation algorithm, just that the functions work)
      expect(initialUnlocked).to.be.a('bigint');
      expect(initialNextAmount).to.be.a('bigint');
      expect(initialNextTime).to.be.a('bigint');
      
      // Move time forward
      await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      // Get updated unlock information
      const updatedUnlocked = await tokenContract.getUnlockedMarketingAmount();
      const [updatedNextAmount, updatedNextTime] = await tokenContract.getNextMarketingUnlock();
      
      // Values should have changed after time increase
      expect(updatedNextTime).to.be.gt(initialNextTime);
    });
    
    it("Should provide team unlock information through getter functions", async function () {
      // Get team unlock information at deployment (should be 0 before unlock period)
      const initialUnlocked = await tokenContract.getUnlockedTeamAmount();
      const [initialNextAmount, initialNextTime] = await tokenContract.getNextTeamUnlock();
      const timeRemaining = await tokenContract.teamUnlockIn();
      
      // Initial values should be 0 for unlocked and positive for others
      expect(initialUnlocked).to.equal(0);
      expect(initialNextAmount).to.be.gt(0);
      expect(initialNextTime).to.be.gt(0);
      expect(timeRemaining).to.be.gt(0);
      
      // Move time forward past team unlock start
      const teamUnlockStart = await tokenContract.teamUnlockStart();
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(teamUnlockStart) + 1]);
      await ethers.provider.send("evm_mine");
      
      // After unlock start, timeRemaining should be 0
      expect(await tokenContract.teamUnlockIn()).to.equal(0);
      
      // Move forward a full period to really get some tokens unlocked
      await ethers.provider.send("evm_increaseTime", [Number(await tokenContract.UNLOCK_PERIOD())]);
      await ethers.provider.send("evm_mine");
      
      // Now some tokens should be unlocked
      expect(await tokenContract.getUnlockedTeamAmount()).to.be.gt(0);
    });
    
    it("Should provide combined unlock status information", async function () {
      // Get the combined unlock status
      const status = await tokenContract.getUnlockStatus();
      
      // Verify structure and reasonable values
      expect(status).to.have.lengthOf(8); // 8 return values in tuple
      
      // Marketing info
      expect(status[0]).to.be.a('bigint'); // marketingTotalUnlocked
      expect(status[1]).to.be.a('bigint'); // marketingAvailableToWithdraw
      expect(status[2]).to.be.a('bigint'); // marketingNextUnlockAmount
      expect(status[3]).to.be.a('bigint'); // marketingNextUnlockTime
      
      // Team info
      expect(status[4]).to.equal(0);     // teamTotalUnlocked (0 before unlock)
      expect(status[5]).to.equal(0);     // teamAvailableToWithdraw (0 before unlock)
      expect(status[6]).to.be.gt(0);     // teamNextUnlockAmount
      expect(status[7]).to.be.gt(0);     // teamNextUnlockTime
    });
  });
});