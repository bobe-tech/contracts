// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract StakingContract is Initializable, AccessControlUpgradeable {
    using Math for uint256;
    using SafeERC20 for IERC20;

    event Deposit(uint256 amount);
    event Withdraw(uint256 amount);
    event Announce(uint256 start, uint256 finish, uint256 amount);

    event Stake(address user, uint256 amount);
    event Unstake(address user, uint256 amount);
    event ClaimRewards(address user, uint256 amount);

    event TokenAddressesSet(address stakingToken, address rewardsToken);
    event CampaignDurationSet(uint256 duration);
    event UnstakePeriodSet(uint256 period);

    address[] public allStakers;

    address public stakingToken;
    address public rewardsToken;
    bool private tokensInitialized;

    uint256 public deposited;
    uint256 public distributed;
    uint256 public totalAllocatedRewards;
    uint256 public totalRewardsCommitted;

    uint256 public campaignDuration;
    uint256 public unstakePeriod;

    uint256 public scStartTimestamp;
    uint256 public scFinishTimestamp;
    uint256 public scRewardsAmount;

    uint256 public globalTimestamp;
    uint256 public globalStake;
    uint256 public globalIndex;

    mapping(address => uint256) public localStake;
    mapping(address => uint256) public localIndex;
    mapping(address => uint256) public localRewards;

    mapping(address => uint256) public totalClaimedRewards;
    mapping(address => uint256) public totalUnstaked;

    mapping(address => uint256[]) public userStakeAmounts;
    mapping(address => uint256[]) public userStakeTimes;

    bytes32 public constant ANNOUNCER_ROLE = keccak256("ANNOUNCER_ROLE");

    function initialize() public initializer {
        _grantRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _grantRole(ANNOUNCER_ROLE, _msgSender());
        campaignDuration = (23*60 + 58) * 60;
        unstakePeriod = 365 * 24 * 3600;
        tokensInitialized = false;
        totalAllocatedRewards = 0;
        totalRewardsCommitted = 0;
    }

    function setTokenAddresses(address _stakingToken, address _rewardsToken) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!tokensInitialized, "Token addresses can only be set once");
        require(_stakingToken != address(0), "Invalid staking token address");
        require(_rewardsToken != address(0), "Invalid rewards token address");
        require(_stakingToken != _rewardsToken, "Staking and rewards tokens must be different");

        stakingToken = _stakingToken;
        rewardsToken = _rewardsToken;
        tokensInitialized = true;

        emit TokenAddressesSet(_stakingToken, _rewardsToken);
    }

    function setCampaignDuration(uint256 _duration) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_duration > 0, "Duration must be > 0");
        campaignDuration = _duration;

        emit CampaignDurationSet(_duration);
    }

    function setUnstakePeriod(uint256 _period) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_period > 0, "Duration must be > 0");
        unstakePeriod = _period;

        emit UnstakePeriodSet(_period);
    }

    function withdraw(address tokenAddress, uint256 amount) public onlyRole(DEFAULT_ADMIN_ROLE) {
        require(amount > 0, "Amount must be > 0");

        uint256 balance = IERC20(tokenAddress).balanceOf(address(this));
        require(balance >= amount, "Insufficient token balance");

        if (tokenAddress == stakingToken) {
            require(balance - amount >= globalStake, "Cannot withdraw staked tokens");
        } else if (tokenAddress == rewardsToken) {
            uint256 availableForWithdrawal = deposited - totalRewardsCommitted;
            require(amount <= availableForWithdrawal, "Cannot withdraw reserved reward tokens");
            deposited -= amount;
        }

        IERC20(tokenAddress).safeTransfer(_msgSender(), amount);

        emit Withdraw(amount);
    }

    function deposit(uint256 amount) public {
        require(amount > 0, "Amount must be > 0");
        require(tokensInitialized, "Token addresses must be set first");

        deposited += amount;
        IERC20(rewardsToken).safeTransferFrom(_msgSender(), address(this), amount);

        emit Deposit(amount);
    }

    function announce(uint256 rewardsAmount) public {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, _msgSender()) ||
            hasRole(ANNOUNCER_ROLE, _msgSender()),
            "Caller must be admin or announcer"
        );
        require(scFinishTimestamp < block.timestamp, "The previous campaign hasn't finished");
        require(rewardsAmount > 0, "Rewards amount must be greater than zero");
        require(tokensInitialized, "Token addresses must be set first");

        _updateGlobalIndex();

        require(deposited - distributed >= rewardsAmount, "Not enough deposit for the campaign");

        totalRewardsCommitted = distributed + rewardsAmount;

        scStartTimestamp = block.timestamp;
        scFinishTimestamp = scStartTimestamp + campaignDuration;
        scRewardsAmount = rewardsAmount;

        emit Announce(scStartTimestamp, scFinishTimestamp, scRewardsAmount);
    }

    function depositAndAnnounce(uint256 depositAmount) public {
        require(
            hasRole(DEFAULT_ADMIN_ROLE, _msgSender()) ||
            hasRole(ANNOUNCER_ROLE, _msgSender()),
            "Caller must be admin or announcer"
        );
        deposit(depositAmount);
        announce(depositAmount);
    }

    function getAvailableRewards() public view returns (
        uint256 distributedExactly,
        uint256 availableRewards
    ) {
        uint256 totalDistributed = 0;
        for (uint i = 0; i < allStakers.length; i++) {
            address staker = allStakers[i];

            if (localStake[staker] > 0 || localRewards[staker] > 0) {
                totalDistributed += rewards(staker);
            }
            totalDistributed += totalClaimedRewards[staker];
        }

        uint256 pendingRewards = totalRewardsCommitted - distributed;

        return (
            totalDistributed,
            deposited - pendingRewards
        );
    }

    function stake(uint256 amount) public {
        require(amount > 0, "Amount must be > 0");
        require(tokensInitialized, "Token addresses must be set first");

        _updateGlobalIndex();
        _updateLocalIndex(_msgSender());

        if (userStakeAmounts[_msgSender()].length == 0) {
            allStakers.push(_msgSender());
        }

        globalStake += amount;
        localStake[_msgSender()] += amount;

        userStakeAmounts[_msgSender()].push(amount);
        userStakeTimes[_msgSender()].push(block.timestamp);

        IERC20(stakingToken).safeTransferFrom(_msgSender(), address(this), amount);

        emit Stake(_msgSender(), amount);
    }

    function unstake(uint256 amount) public {
        require(amount > 0, "Amount must be > 0");

        uint256 unlockable = getUnlockableAmount(_msgSender());
        require(unlockable >= amount, "Amount exceeds unlockable balance");

        _updateGlobalIndex();
        _updateLocalIndex(_msgSender());

        globalStake -= amount;
        localStake[_msgSender()] -= amount;

        totalUnstaked[_msgSender()] += amount;

        IERC20(stakingToken).safeTransfer(_msgSender(), amount);

        emit Unstake(_msgSender(), amount);
    }

    function getUnlockableAmount(address user) public view returns (uint256) {
        uint256[] memory amounts = userStakeAmounts[user];
        uint256[] memory times = userStakeTimes[user];
        uint256 unlockable = 0;

        for(uint i = 0; i < amounts.length; i++) {
            if (block.timestamp - times[i] >= unstakePeriod) {
                unlockable += amounts[i];
            }
        }

        uint256 totalUnstakedAmount = totalUnstaked[user];
        if (unlockable <= totalUnstakedAmount) {
            return 0;
        }

        return unlockable - totalUnstakedAmount;
    }

    function claimRewards() public {
        require(tokensInitialized, "Token addresses must be set first");

        _updateGlobalIndex();
        _updateLocalIndex(_msgSender());

        uint256 amount = localRewards[_msgSender()];
        require(amount > 0, "No rewards");

        localRewards[_msgSender()] = 0;

        totalClaimedRewards[_msgSender()] += amount;

        IERC20(rewardsToken).safeTransfer(_msgSender(), amount);

        emit ClaimRewards(_msgSender(), amount);
    }

    function _updateGlobalIndex() private {
        uint256 previousGlobalIndex = globalIndex;

        globalIndex = index();
        globalTimestamp = block.timestamp;

        distributed += (globalIndex - previousGlobalIndex) * globalStake / 1e18;
    }

    function _updateLocalIndex(address addr) private {
        localRewards[addr] = rewards(addr);
        localIndex[addr] = index();
    }

    function _rate() private view returns (uint256) {
        if (globalStake == 0) return 0;
        return 1e18 * scRewardsAmount / globalStake / (scFinishTimestamp - scStartTimestamp);
    }

    function index() public view returns (uint256) {
        uint256 left = Math.max(scStartTimestamp, globalTimestamp);
        uint256 right = Math.min(block.timestamp, scFinishTimestamp);

        if (left > right) return globalIndex;

        return globalIndex + (right - left) * _rate();
    }

    function rewards(address addr) public view returns (uint256) {
        return localRewards[addr] + localStake[addr] * (index() - localIndex[addr]) / 1e18;
    }

    function getUserStats(address user) public view returns (
        uint256 currentStake,
        uint256 pendingRewards,
        uint256 totalClaimedUsdt,
        uint256 rewardsPerSecond,

        uint256[] memory stakeAmounts,
        uint256[] memory stakeTimes,
        uint256 unlockedAmount,
        uint256 totalUnstakedAmount,
        uint256 unstakePeriod,
        uint256 tokenBalance
    ) {
        uint256 userRewardRate = 0;
        if (block.timestamp >= scStartTimestamp && block.timestamp <= scFinishTimestamp) {
            userRewardRate = _rate() * localStake[user] / 1e18;
        }

        return (
            localStake[user],
            rewards(user),
            totalClaimedRewards[user],
            userRewardRate,

            userStakeAmounts[user],
            userStakeTimes[user],
            getUnlockableAmount(user),
            totalUnstaked[user],
            unstakePeriod,
            IERC20(stakingToken).balanceOf(user)
        );
    }

    function getGlobalStats() public view returns (
        uint256 totalStaked,
        uint256 totalStakers,
        uint256 activeStakers,

        uint256 totalDistributed,
        uint256 availableBank,

        uint256 currentCampaignRewards,
        uint256 campaignStart,
        uint256 campaignEnd,

        uint256 rewardRatePerToken
    ) {
        uint256 currentStakerCount = 0;
        for (uint i = 0; i < allStakers.length; i++) {
            if (localStake[allStakers[i]] > 0) {
                currentStakerCount++;
            }
        }

        (uint256 distributedExactly, uint256 availableRewards) = getAvailableRewards();

        uint256 currentRate = 0;
        if (scFinishTimestamp > 0 && scStartTimestamp > 0) {
            currentRate = _rate();
        }

        return (
            globalStake,
            allStakers.length,
            currentStakerCount,

            distributedExactly,
            availableRewards,

            scRewardsAmount,
            scStartTimestamp,
            scFinishTimestamp,

            currentRate
        );
    }
}
