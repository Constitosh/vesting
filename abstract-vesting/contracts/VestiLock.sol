// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VestiLock – ERC20 time-lock escrow (depositor-only withdraw) with flat ETH fee
/// @notice Users lock ERC-20 for a fixed duration; only depositor can withdraw after unlock.
///         A flat 0.015 ETH fee is required per position and forwarded to feeCollector.
contract VestiLock is ReentrancyGuard, Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    struct Position {
        address user;      // depositor & sole withdrawer
        address token;     // ERC20 token
        uint256 amount;    // locked amount
        uint64  unlockAt;  // unix timestamp when withdraw allowed
    }

    /// @dev positionId => Position
    mapping(uint256 => Position) public positions;
    uint256 public nextId;

    /// @dev allowed durations in days
    mapping(uint32 => bool) public allowedDays;

    /// @dev Flat fee in wei (0.015 ETH). Editable via owner.
    uint256 public feeWei = 0.015 ether;

    /// @dev Recipient of ETH fees and sweeps (your special wallet)
    address public feeCollector;

    event Deposit(uint256 indexed id, address indexed user, address indexed token, uint256 amount, uint64 unlockAt);
    event Withdraw(uint256 indexed id, address indexed user, address indexed token, uint256 amount);
    event AllowedDurationSet(uint32 days_, bool allowed);
    event FeeUpdated(uint256 feeWei);
    event FeeCollectorUpdated(address account);

    constructor(uint32[] memory initialAllowedDays, address feeCollector_) {
        require(initialAllowedDays.length > 0, "no durations");
        require(feeCollector_ != address(0), "collector=0");
        feeCollector = feeCollector_;
        for (uint256 i = 0; i < initialAllowedDays.length; i++) {
            allowedDays[initialAllowedDays[i]] = true;
            emit AllowedDurationSet(initialAllowedDays[i], true);
        }
    }

    // -------------------- Admin --------------------

    function setAllowedDuration(uint32 days_, bool allowed) external onlyOwner {
        allowedDays[days_] = allowed;
        emit AllowedDurationSet(days_, allowed);
    }

    function setFeeWei(uint256 newFee) external onlyOwner {
        feeWei = newFee;
        emit FeeUpdated(newFee);
    }

    function setFeeCollector(address account) external onlyOwner {
        require(account != address(0), "collector=0");
        feeCollector = account;
        emit FeeCollectorUpdated(account);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Sweep stray ETH to feeCollector (does NOT affect ERC-20 escrow)
    function sweepEth(uint256 amount) external {
        require(msg.sender == feeCollector || msg.sender == owner(), "not allowed");
        (bool ok, ) = feeCollector.call{value: amount}("");
        require(ok, "eth sweep failed");
    }

    /// @notice Sweep non-escrow ERC-20 mistakenly sent to this contract address (rare)
    /// @dev Does *not* touch escrowed balances since those are tracked in storage and paid only via withdraw.
    function sweepToken(address token, uint256 amount) external {
        require(msg.sender == feeCollector || msg.sender == owner(), "not allowed");
        IERC20(token).safeTransfer(feeCollector, amount);
    }

    // -------------------- User flow --------------------

    /// @notice Approve → then call lock() with exact fee (feeWei). Locks ERC-20 until unlock.
    function lock(address token, uint256 amount, uint32 days_) external payable whenNotPaused nonReentrant returns (uint256 id) {
        require(token != address(0), "token=0");
        require(amount > 0, "no amount");
        require(allowedDays[days_], "bad duration");
        require(msg.value == feeWei, "fee 0.015 ETH required");

        // Transfer fee immediately to feeCollector
        (bool ok, ) = feeCollector.call{value: msg.value}("");
        require(ok, "fee xfer failed");

        id = ++nextId;

        // Pull tokens into escrow
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        positions[id] = Position({
            user: msg.sender,
            token: token,
            amount: amount,
            unlockAt: uint64(block.timestamp + uint256(days_) * 1 days)
        });

        emit Deposit(id, msg.sender, token, amount, positions[id].unlockAt);
    }

    /// @notice ONLY the depositor can withdraw after unlock time.
    function withdraw(uint256 id) external nonReentrant {
        Position memory p = positions[id];
        require(p.user != address(0), "no position");
        require(msg.sender == p.user, "not depositor");
        require(block.timestamp >= p.unlockAt, "locked");

        delete positions[id];
        IERC20(p.token).safeTransfer(p.user, p.amount);
        emit Withdraw(id, p.user, p.token, p.amount);
    }

    function getPosition(uint256 id) external view returns (Position memory) { return positions[id]; }
}
