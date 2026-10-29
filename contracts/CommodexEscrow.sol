// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev The subset of ERC-20 the escrow needs. Written out here so the contract has no dependencies.
interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title CommodexEscrow
/// @notice Holds one buyer's stablecoin for one trade until delivery is confirmed, the buyer is
///         refunded, the deadline passes, or an operator resolves a dispute. TESTNET ONLY: the
///         single token is a test stablecoin on Avalanche Fuji. No FX, no partial releases.
/// @dev    One escrow per `tradeId` (bytes32, the ledger's trade hash). Terminal states are final.
///         Pausing blocks new escrows only, so it can never trap funds in an open trade.
///         Fee-on-transfer tokens are rejected by a balance-delta check when funds come in.
contract CommodexEscrow {
    enum Status { NONE, FUNDED, DISPUTED, RELEASED, REFUNDED }
    enum Reason { REFUND, EXPIRED, RESOLVED }

    struct Escrow {
        address buyer;
        address seller;
        uint256 amount;
        uint64 deadline;
        uint64 createdAt;
        Status status;
    }

    uint256 public constant MAX_AMOUNT = 1_000_000e6;   // 1,000,000 tUSDC (6 decimals)
    uint64 public constant MIN_WINDOW = 1 hours;
    uint64 public constant MAX_WINDOW = 30 days;
    uint16 public constant MAX_FEE_BPS = 300;           // 3%

    IERC20Minimal public immutable token;
    address public owner;
    address public pendingOwner;
    address public operator;
    address public feeRecipient;
    uint16 public feeBps;
    bool public paused;

    mapping(bytes32 => Escrow) public escrows;

    uint256 private _lock = 1;

    event EscrowFunded(bytes32 indexed tradeId, address indexed buyer, address indexed seller, uint256 amount, uint64 deadline);
    event EscrowReleased(bytes32 indexed tradeId, address indexed seller, uint256 amount, uint256 fee);
    event EscrowRefunded(bytes32 indexed tradeId, address indexed buyer, uint256 amount, Reason reason);
    event EscrowDisputed(bytes32 indexed tradeId, address indexed by);
    event EscrowResolved(bytes32 indexed tradeId, bool toSeller);
    event OperatorSet(address indexed previous, address indexed next);
    event FeeSet(uint16 bps);
    event FeeRecipientSet(address indexed next);
    event PauseSet(bool paused);
    event OwnershipTransferStarted(address indexed previous, address indexed next);
    event OwnershipTransferred(address indexed previous, address indexed next);

    error NotOwner();
    error NotPending();
    error NotOperator();
    error NotParty();
    error ZeroAddress();
    error ZeroTrade();
    error TradeExists(bytes32 tradeId);
    error SellerIsBuyer();
    error BadAmount();
    error BadDeadline();
    error NotExpired();
    error FeeTooHigh();
    error ContractPaused();
    error WrongStatus(Status current);
    error TransferFailed();
    error FeeOnTransfer(uint256 expected, uint256 received);
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_, address operator_, address feeRecipient_) {
        if (token_ == address(0) || operator_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        token = IERC20Minimal(token_);
        owner = msg.sender;
        operator = operator_;
        feeRecipient = feeRecipient_;
        emit OperatorSet(address(0), operator_);
        emit FeeRecipientSet(feeRecipient_);
    }

    // ---------------------------------------------------------------- trade lifecycle

    /// @notice Buyer locks `amount` for `seller`. Buyer must have approved this contract first.
    function createAndFund(bytes32 tradeId, address seller, uint256 amount, uint64 deadline) external nonReentrant {
        if (paused) revert ContractPaused();
        if (tradeId == bytes32(0)) revert ZeroTrade();
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.NONE) revert TradeExists(tradeId);
        if (seller == address(0)) revert ZeroAddress();
        if (seller == msg.sender) revert SellerIsBuyer();
        if (amount == 0 || amount > MAX_AMOUNT) revert BadAmount();
        if (deadline < block.timestamp + MIN_WINDOW || deadline > block.timestamp + MAX_WINDOW) revert BadDeadline();

        e.buyer = msg.sender;
        e.seller = seller;
        e.amount = amount;
        e.deadline = deadline;
        e.createdAt = uint64(block.timestamp);
        e.status = Status.FUNDED;

        _pullExact(msg.sender, amount);
        emit EscrowFunded(tradeId, msg.sender, seller, amount, deadline);
    }

    /// @notice Buyer (or operator) confirms delivery: pays the seller, minus the fee.
    function release(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.FUNDED) revert WrongStatus(e.status);
        if (msg.sender != e.buyer && msg.sender != operator) revert NotParty();

        e.status = Status.RELEASED;
        (uint256 net, uint256 fee) = _split(e.amount);
        _send(e.seller, net);
        if (fee > 0) _send(feeRecipient, fee);
        emit EscrowReleased(tradeId, e.seller, net, fee);
    }

    /// @notice Seller (or operator) returns the full amount to the buyer.
    function refund(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.FUNDED) revert WrongStatus(e.status);
        if (msg.sender != e.seller && msg.sender != operator) revert NotParty();

        e.status = Status.REFUNDED;
        _send(e.buyer, e.amount);
        emit EscrowRefunded(tradeId, e.buyer, e.amount, Reason.REFUND);
    }

    /// @notice Anyone may call once the deadline has passed: the buyer gets the full amount back.
    ///         Liveness guarantee, so buyer funds can never be locked forever.
    function expire(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.FUNDED && e.status != Status.DISPUTED) revert WrongStatus(e.status);
        if (block.timestamp < e.deadline) revert NotExpired();

        e.status = Status.REFUNDED;
        _send(e.buyer, e.amount);
        emit EscrowRefunded(tradeId, e.buyer, e.amount, Reason.EXPIRED);
    }

    /// @notice Buyer or seller freezes a funded trade for the operator to decide.
    function dispute(bytes32 tradeId) external {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.FUNDED) revert WrongStatus(e.status);
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParty();

        e.status = Status.DISPUTED;
        emit EscrowDisputed(tradeId, msg.sender);
    }

    /// @notice Operator decides a disputed trade. `toSeller` true pays the seller (fee applies),
    ///         false refunds the buyer in full.
    function resolve(bytes32 tradeId, bool toSeller) external nonReentrant onlyOperator {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.DISPUTED) revert WrongStatus(e.status);

        if (toSeller) {
            e.status = Status.RELEASED;
            (uint256 net, uint256 fee) = _split(e.amount);
            _send(e.seller, net);
            if (fee > 0) _send(feeRecipient, fee);
            emit EscrowReleased(tradeId, e.seller, net, fee);
        } else {
            e.status = Status.REFUNDED;
            _send(e.buyer, e.amount);
            emit EscrowRefunded(tradeId, e.buyer, e.amount, Reason.RESOLVED);
        }
        emit EscrowResolved(tradeId, toSeller);
    }

    // ---------------------------------------------------------------- owner controls

    /// @notice Stops new escrows only. Existing trades can always be released, refunded, expired or resolved.
    function pause() external onlyOwner {
        paused = true;
        emit PauseSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseSet(false);
    }

    function setOperator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OperatorSet(operator, next);
        operator = next;
    }

    function setFee(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setFeeRecipient(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        feeRecipient = next;
        emit FeeRecipientSet(next);
    }

    /// @notice Two-step ownership transfer. Pass address(0) to cancel a pending transfer.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPending();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- internals

    function _split(uint256 amount) private view returns (uint256 net, uint256 fee) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }

    /// @dev Pulls `amount` and checks the escrow actually received it (rejects fee-on-transfer tokens).
    function _pullExact(address from, uint256 amount) private {
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(from, address(this), amount)) revert TransferFailed();
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransfer(amount, received);
    }

    function _send(address to, uint256 amount) private {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
