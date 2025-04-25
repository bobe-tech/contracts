const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TokenContract", function () {
  let tokenContract;
  let owner;
  let user;

  beforeEach(async function () {
    // Get signers
    [owner, user] = await ethers.getSigners();
    
    // Deploy the TokenContract with multisig address (using owner as mock multisig for test)
    const TokenContract = await ethers.getContractFactory("TokenContract");
    tokenContract = await TokenContract.deploy(owner.address);
    await tokenContract.deploymentTransaction().wait();
  });

  describe("Deployment", function () {
    it("Should deploy the contract with correct initial values", async function () {
      // Check token name and symbol
      expect(await tokenContract.name()).to.equal("Bobe.app");
      expect(await tokenContract.symbol()).to.equal("BOBE");
      
      // Check total supply (1 billion tokens with 18 decimals)
      const expectedTotalSupply = ethers.parseEther("1000000000");
      expect(await tokenContract.totalSupply()).to.equal(expectedTotalSupply);
      
      // Check contract token balance equals total supply
      expect(await tokenContract.balanceOf(await tokenContract.getAddress())).to.equal(expectedTotalSupply);
      
      // Check supply distributions
      const liquiditySupply = await tokenContract.liquiditySupply();
      const marketingSupply = await tokenContract.marketingSupply();
      const teamSupply = await tokenContract.teamSupply();
      
      // Verify distribution percentages
      expect(liquiditySupply).to.equal(expectedTotalSupply * 80n / 100n);
      expect(marketingSupply).to.equal(expectedTotalSupply * 12n / 100n);
      expect(teamSupply).to.equal(expectedTotalSupply - (liquiditySupply + marketingSupply));
      
      // Check remaining token amounts
      expect(await tokenContract.liquidityLeft()).to.equal(liquiditySupply);
      expect(await tokenContract.marketingLeft()).to.equal(marketingSupply);
      expect(await tokenContract.teamLeft()).to.equal(teamSupply);
      
      // Check unlocked portions initialized to 0
      expect(await tokenContract.marketingUnlockedPortions()).to.equal(0);
      expect(await tokenContract.teamUnlockedPortions()).to.equal(0);
      
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
      const deployBlock = await ethers.provider.getBlock(tokenContract.deploymentTransaction().blockHash);
      expect(Number(marketingStart)).to.be.closeTo(Number(deployBlock.timestamp), 10); // Within 10 seconds of deployment
      
      // Check team unlock starts after 548 days
      const teamStart = await tokenContract.teamUnlockStart();
      expect(teamStart).to.be.closeTo(BigInt(deployBlock.timestamp) + BigInt(548 * 24 * 60 * 60), 10n);
    });
  });
});