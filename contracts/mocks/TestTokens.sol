// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MockUSDC
/// @notice Test stablecoin for Avalanche Fuji. No value. Owner (deployer) mints test supply.
contract MockUSDC {
    string public constant name = "Test USDC";
    string public constant symbol = "tUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner_, address indexed spender, uint256 value);

    error NotOwner();
    error Insufficient();
    error Allowance();

    constructor() {
        owner = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert Allowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal virtual {
        if (balanceOf[from] < value) revert Insufficient();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        _afterMove(to);
    }

    function _afterMove(address) internal virtual {}
}

/// @title FeeOnTransferUSDC
/// @notice Test token that burns 1% on every transfer. The escrow must reject it.
contract FeeOnTransferUSDC is MockUSDC {
    function _move(address from, address to, uint256 value) internal override {
        if (balanceOf[from] < value) revert Insufficient();
        uint256 fee = value / 100;
        balanceOf[from] -= value;
        balanceOf[to] += value - fee;
        totalSupply -= fee;
        emit Transfer(from, to, value - fee);
    }
}

/// @title HookUSDC
/// @notice Test token that, once armed, calls back into a target after the next transfer.
///         Used to prove a malicious token cannot re-enter the escrow mid-payout.
contract HookUSDC is MockUSDC {
    address public hookTarget;
    bytes public hookData;
    bool public hookRan;
    bool public hookOk;

    function arm(address target, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner();
        hookTarget = target;
        hookData = data;
        hookRan = false;
        hookOk = false;
    }

    function _afterMove(address) internal override {
        if (hookTarget != address(0) && !hookRan) {
            hookRan = true;
            (hookOk, ) = hookTarget.call(hookData);
        }
    }
}
