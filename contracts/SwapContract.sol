// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

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

contract SwapContract is Initializable, AccessControlUpgradeable {
    using Math for uint256;
    using SafeERC20 for IERC20;

    AggregatorV3Interface internal bnbPriceFeed;

    address public adminAddress;
    address public mainTokenAddress;
    bool private mainTokenInitialized;
    uint256 public mainTokenPriceInUsdt;

    address public constant SMART_ROUTER_ADDRESS = 0x13f4EA83D0bd40E75C8222255bc855a974568Dd4;

    address public constant WBNB_ADDRESS = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    address public constant USDT_ADDRESS = 0x55d398326f99059fF775485246999027B3197955;
    address public constant FDUSD_ADDRESS = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409;
    address public constant DAI_ADDRESS = 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3;
    address public constant USDC_ADDRESS = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

    mapping(address => bool) public allowedStableTokens;

    event PriceUpdated(uint256 newPrice);
    event TokenAllowed(address token);
    event TokenDisallowed(address token);
    event MainTokenSet(address mainToken);
    event AdminAddressSet(address admin);

    event TokensPurchased(
        address indexed user,
        address tokenIn,
        uint256 tokenInAmount,
        uint256 usdtValue,
        uint256 mainTokenAmount
    );

    function initialize() public initializer {
        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        adminAddress = _msgSender();
        mainTokenPriceInUsdt = 1100000000000000000;
        mainTokenInitialized = false;

        allowedStableTokens[USDT_ADDRESS] = true;
        allowedStableTokens[FDUSD_ADDRESS] = true;
        allowedStableTokens[DAI_ADDRESS] = true;
        allowedStableTokens[USDC_ADDRESS] = true;

        bnbPriceFeed = AggregatorV3Interface(0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE);
    }

    function setMainTokenAddress(address _mainTokenAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!mainTokenInitialized, "Main token address can only be set once");
        require(_mainTokenAddress != address(0), "Invalid main token address");
        mainTokenAddress = _mainTokenAddress;
        mainTokenInitialized = true;
        emit MainTokenSet(_mainTokenAddress);
    }

    function setAdminAddress(address _adminAddress) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_adminAddress != address(0), "Invalid admin address");
        adminAddress = _adminAddress;
        emit AdminAddressSet(_adminAddress);
    }

    function setPrice(uint256 _newPrice) public onlyRole(DEFAULT_ADMIN_ROLE) {
        mainTokenPriceInUsdt = _newPrice;
        emit PriceUpdated(_newPrice);
    }

    function allowStableTokens(address[] calldata tokens) public onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint i = 0; i < tokens.length; i++) {
            allowedStableTokens[tokens[i]] = true;

            emit TokenAllowed(tokens[i]);
        }
    }

    function disallowStableToken(address _token) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(allowedStableTokens[_token], "Token not found in allowed lists");
        allowedStableTokens[_token] = false;

        emit TokenDisallowed(_token);
    }

    function convertDecimals(
        uint256 value,
        uint256 sourceDecimals,
        uint256 targetDecimals
    ) public pure returns (uint256) {
        if (sourceDecimals == targetDecimals) return value;
        else if (sourceDecimals > targetDecimals) return value / (10 ** (sourceDecimals - targetDecimals));
        else return value * (10 ** (targetDecimals - sourceDecimals));
    }

    function convertBnbToUsdt(uint256 amount) public view returns (uint256) {
        (, int256 price, , , ) = bnbPriceFeed.latestRoundData();
        require(price > 0, "Invalid price");

        uint8 priceDecimals = bnbPriceFeed.decimals();
        uint256 usdtPriceValue = convertDecimals(uint256(price), priceDecimals, 18);

        return (usdtPriceValue * amount) / 1e18;
    }

    function swapNativeToken() external payable {
        uint256 tokenAmount = msg.value;
        require(tokenAmount > 0, "Amount must be greater than 0");
        require(mainTokenInitialized, "Main token address must be set first");

        (bool success, ) = payable(adminAddress).call{value: msg.value}("");
        require(success, "Failed to send BNB");

        uint256 usdtValue = convertBnbToUsdt(tokenAmount);
        require(usdtValue > 0, "Failed to get price");

        uint256 mainTokenAmount = (usdtValue * 1e18) / mainTokenPriceInUsdt;
        require(
            IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount,
            "Insufficient main token balance"
        );
        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit TokensPurchased(msg.sender, WBNB_ADDRESS, tokenAmount, usdtValue, mainTokenAmount);
    }

    function swapStableTokens(address token, uint256 amountIn) external payable {
        require(amountIn > 0, "Amount must be greater than 0");
        require(allowedStableTokens[token], "Token not allowed");
        require(mainTokenInitialized, "Main token address must be set first");

        IERC20(token).transferFrom(msg.sender, adminAddress, amountIn);

        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        uint256 usdtValue = convertDecimals(amountIn, tokenDecimals, 18);

        uint256 mainTokenAmount = (usdtValue * 1e18) / mainTokenPriceInUsdt;
        require(
            IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount,
            "Insufficient main token balance"
        );
        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit TokensPurchased(msg.sender, token, amountIn, usdtValue, mainTokenAmount);
    }

    function swapAnyTokens(
        address tokenIn,
        uint256 amountIn,
        address[] calldata path,
        uint256 userSlippageBps
    ) external payable {
        require(amountIn > 0, "Amount must be greater than 0");
        require(mainTokenInitialized, "Main token address must be set first");
        require(!allowedStableTokens[tokenIn], "Use swapStableTokens for stablecoins");
        require(userSlippageBps < 1000, "Slippage too high"); // 10%

        require(path.length >= 2, "Path too short");
        require(path[0] == tokenIn, "Path start must match input token");
        require(path[path.length - 1] == USDT_ADDRESS, "Path must end with USDT");

        uint256[] memory expectedAmounts = IPancakeSwapV3Router(SMART_ROUTER_ADDRESS).getAmountsOut(amountIn, path);
        uint256 expectedUsdtAmount = expectedAmounts[expectedAmounts.length - 1];
        uint256 minAmountOut = (expectedUsdtAmount * (10000 - userSlippageBps)) / 10000;

        uint256 usdtBefore = IERC20(USDT_ADDRESS).balanceOf(adminAddress);

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).approve(SMART_ROUTER_ADDRESS, amountIn);
        IPancakeSwapV3Router(SMART_ROUTER_ADDRESS).swapExactTokensForTokens(amountIn, minAmountOut, path, adminAddress);

        uint256 usdtAfter = IERC20(USDT_ADDRESS).balanceOf(adminAddress);
        uint256 usdtReceived = usdtAfter - usdtBefore;
        require(usdtReceived > 0, "No USDT received");

        uint256 mainTokenAmount = (usdtReceived * 1e18) / mainTokenPriceInUsdt;
        require(mainTokenAmount > 0, "Main token amount is zero");
        require(
            IERC20(mainTokenAddress).balanceOf(address(this)) >= mainTokenAmount,
            "Insufficient main token balance"
        );

        IERC20(mainTokenAddress).safeTransfer(msg.sender, mainTokenAmount);

        emit TokensPurchased(msg.sender, tokenIn, amountIn, usdtReceived, mainTokenAmount);
    }
}
