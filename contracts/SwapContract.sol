// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

interface IPancakeSwapV3Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to
    ) external payable returns (uint256 amountOut);

    function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts);
}

contract SwapContract is Initializable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using Math for uint256;
    using SafeERC20 for IERC20;

    AggregatorV3Interface public bnbPriceFeed;

    address public fundingAddress;
    address public mainTokenAddress;
    bool private mainTokenInitialized;
    uint256 public mainTokenPriceInUsdt;

    // Address of PancakeSwap V3 Router
    address public smartRouterAddress;

    // USDT address is needed for swapAnyTokens
    address public usdtAddress;

    mapping(address => bool) public allowedStableTokens;

    event TokenAllowed(address token);
    event TokenDisallowed(address token);
    event MainTokenSet(address mainToken);
    event FundingAddressSet(address newAddress);
    event UsdtAddressSet(address newUsdtAddress);
    event BnbPriceFeedSet(address newPriceFeedAddress);
    event SmartRouterSet(address newRouterAddress);

    event NativeTokenPurchased(address indexed user, uint256 bnbAmount, uint256 usdtValue, uint256 mainTokenAmount);

    event TokensPurchased(address indexed user, address tokenIn, uint256 tokenInAmount, uint256 usdtValue, uint256 mainTokenAmount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address adminMultisigAddress, address fundingMultisigAddress) public initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();

        _grantRole(DEFAULT_ADMIN_ROLE, adminMultisigAddress);
        setFundingAddress(fundingMultisigAddress);

        mainTokenPriceInUsdt = 1_100_000_000_000_000_000;
        mainTokenInitialized = false;
    }

    // Set the USDT address, used for swapAnyTokens as the destination token
    function setUsdtAddress(address newUsdtAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newUsdtAddress != address(0), "USDT address cannot be zero");
        usdtAddress = newUsdtAddress;

        // Automatically add USDT to allowed stable tokens if not already allowed
        if (!allowedStableTokens[newUsdtAddress]) {
            allowStableToken(newUsdtAddress);
        }

        emit UsdtAddressSet(newUsdtAddress);
    }

    // Set the BNB price feed address
    function setBnbPriceFeed(address newPriceFeedAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newPriceFeedAddress != address(0), "Price feed address cannot be zero");
        bnbPriceFeed = AggregatorV3Interface(newPriceFeedAddress);
        emit BnbPriceFeedSet(newPriceFeedAddress);
    }

    // Set the router address
    function setSmartRouterAddress(address newRouterAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newRouterAddress != address(0), "Router address cannot be zero");
        smartRouterAddress = newRouterAddress;
        emit SmartRouterSet(newRouterAddress);
    }

    function setMainTokenAddress(address newMainTokenAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!mainTokenInitialized, "Main token address can only be set once");
        require(newMainTokenAddress != address(0), "Invalid main token address");

        uint256 tokenBalance = IERC20(newMainTokenAddress).balanceOf(address(this));
        require(tokenBalance > 0, "No tokens available on contract balance");

        mainTokenAddress = newMainTokenAddress;
        mainTokenInitialized = true;
        emit MainTokenSet(newMainTokenAddress);
    }

    function setFundingAddress(address newFundingAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFundingAddress != address(0), "Invalid funding address");
        fundingAddress = newFundingAddress;
        emit FundingAddressSet(newFundingAddress);
    }

    function allowStableToken(address token) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0), "Zero address not allowed");
        require(!allowedStableTokens[token], "Token already allowed");

        bool isValidToken = false;
        try IERC20Metadata(token).decimals() returns (uint8) {
            isValidToken = true;
        } catch {}

        require(isValidToken, "Token must support IERC20Metadata interface");

        allowedStableTokens[token] = true;
        emit TokenAllowed(token);
    }

    function disallowStableToken(address tokenAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(allowedStableTokens[tokenAddress], "Token not found in allowed lists");
        require(tokenAddress != usdtAddress, "Cannot disallow USDT");
        allowedStableTokens[tokenAddress] = false;

        emit TokenDisallowed(tokenAddress);
    }

    function convertDecimals(uint256 value, uint256 sourceDecimals, uint256 targetDecimals) public pure returns (uint256) {
        if (sourceDecimals == targetDecimals) return value;
        else if (sourceDecimals > targetDecimals) return value / (10 ** (sourceDecimals - targetDecimals));
        else return value * (10 ** (targetDecimals - sourceDecimals));
    }

    function convertBnbToUsdt(uint256 amount) public view returns (uint256) {
        (, int256 price, , uint256 updatedAt, ) = bnbPriceFeed.latestRoundData();

        require(price > 0, "Invalid price");
        require(block.timestamp - updatedAt <= 1 hours, "Oracle data too old");

        uint8 priceDecimals = bnbPriceFeed.decimals();
        uint256 usdtPriceValue = convertDecimals(uint256(price), priceDecimals, 18);

        return (usdtPriceValue * amount) / 1e18;
    }

    function swapNativeToken() external payable nonReentrant {
        uint256 tokenAmount = msg.value;
        require(tokenAmount > 0, "Amount must be greater than 0");
        require(mainTokenInitialized, "Main token address must be set first");

        (bool success, ) = payable(fundingAddress).call{value: msg.value}("");
        require(success, "Failed to send BNB");

        uint256 usdtValue = convertBnbToUsdt(tokenAmount);
        require(usdtValue > 0, "Failed to get price");

        uint256 mainTokenAmount = (usdtValue * 1e18) / mainTokenPriceInUsdt;
        require(IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount, "Insufficient main token balance");
        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit NativeTokenPurchased(msg.sender, tokenAmount, usdtValue, mainTokenAmount);
    }

    function swapStableTokens(address token, uint256 amountIn) external nonReentrant {
        require(amountIn > 0, "Amount must be greater than 0");
        require(allowedStableTokens[token], "Token not allowed");
        require(mainTokenInitialized, "Main token address must be set first");

        uint256 fundingBalanceBefore = IERC20(token).balanceOf(fundingAddress);
        IERC20(token).safeTransferFrom(msg.sender, fundingAddress, amountIn);
        uint256 fundingBalanceAfter = IERC20(token).balanceOf(fundingAddress);
        uint256 actualAmountIn = fundingBalanceAfter - fundingBalanceBefore;
        require(actualAmountIn > 0, "No tokens received");

        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint256 usdtValue = convertDecimals(actualAmountIn, tokenDecimals, 18);

        uint256 mainTokenAmount = (usdtValue * 1e18) / mainTokenPriceInUsdt;
        require(IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount, "Insufficient main token balance");
        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit TokensPurchased(msg.sender, token, actualAmountIn, usdtValue, mainTokenAmount);
    }

    function swapAnyTokens(address tokenIn, uint256 amountIn, address[] calldata path, uint256 userSlippageBps) external nonReentrant {
        require(amountIn > 0, "Amount must be greater than 0");
        require(mainTokenInitialized, "Main token address must be set first");
        require(!allowedStableTokens[tokenIn], "Use swapStableTokens for stablecoins");
        require(userSlippageBps < 1000, "Slippage too high"); // 10%

        require(path.length >= 2, "Path too short");
        require(path[0] == tokenIn, "Path start must match input token");
        require(usdtAddress != address(0), "USDT address not set");
        require(path[path.length - 1] == usdtAddress, "Path must end with USDT");

        require(smartRouterAddress != address(0), "Router address not set");

        uint256[] memory expectedAmounts = IPancakeSwapV3Router(smartRouterAddress).getAmountsOut(amountIn, path);
        uint256 expectedUsdtAmount = expectedAmounts[expectedAmounts.length - 1];
        uint256 minAmountOut = (expectedUsdtAmount * (10000 - userSlippageBps)) / 10000;

        uint256 tokenBalanceBefore = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 tokenBalanceAfter = IERC20(tokenIn).balanceOf(address(this));
        uint256 actualAmountIn = tokenBalanceAfter - tokenBalanceBefore;
        require(actualAmountIn > 0, "No tokens received");

        uint256 usdtBefore = IERC20(usdtAddress).balanceOf(fundingAddress);
        IERC20(tokenIn).approve(smartRouterAddress, actualAmountIn);
        IPancakeSwapV3Router(smartRouterAddress).swapExactTokensForTokens(actualAmountIn, minAmountOut, path, fundingAddress);
        uint256 usdtAfter = IERC20(usdtAddress).balanceOf(fundingAddress);
        uint256 usdtReceived = usdtAfter - usdtBefore;
        require(usdtReceived > 0, "No USDT received");

        uint256 mainTokenAmount = (usdtReceived * 1e18) / mainTokenPriceInUsdt;
        require(mainTokenAmount > 0, "Main token amount is zero");
        require(IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount, "Insufficient main token balance");

        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit TokensPurchased(msg.sender, tokenIn, actualAmountIn, usdtReceived, mainTokenAmount);
    }
}
