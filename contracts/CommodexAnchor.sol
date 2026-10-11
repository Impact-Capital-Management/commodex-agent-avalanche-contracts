// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title CommodexAnchor
/// @notice Public timestamp for Commodex corridor records on Avalanche.
///         It stores a 32-byte hash and the block it was mined in. Nothing else:
///         no funds, no token, no personal data. A hash reveals nothing about
///         the record it was taken from.
/// @dev    `kind` says what was anchored, e.g. keccak256("LEDGER_HEAD"),
///         keccak256("P2P_ROOT"), keccak256("DUES_REMITTANCE"), keccak256("TEST").
contract CommodexAnchor {
    address public operator;
    mapping(bytes32 => uint256) public anchoredAtBlock;

    event Anchored(bytes32 indexed hash, bytes32 indexed kind, string ref, uint256 blockNumber);
    event OperatorChanged(address indexed previous, address indexed next);

    error NotOperator();
    error AlreadyAnchored(bytes32 hash, uint256 blockNumber);
    error ZeroHash();
    error ZeroOperator();

    constructor() {
        operator = msg.sender;
        emit OperatorChanged(address(0), msg.sender);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @param hash 32-byte digest of the record (never the record itself).
    /// @param kind keccak256 of the record type label.
    /// @param ref  short non-personal reference, e.g. "GH-GOLD-2026-v1/ledger/42".
    function anchor(bytes32 hash, bytes32 kind, string calldata ref) external onlyOperator {
        if (hash == bytes32(0)) revert ZeroHash();
        uint256 seen = anchoredAtBlock[hash];
        if (seen != 0) revert AlreadyAnchored(hash, seen);
        anchoredAtBlock[hash] = block.number;
        emit Anchored(hash, kind, ref, block.number);
    }

    function setOperator(address next) external onlyOperator {
        if (next == address(0)) revert ZeroOperator();
        emit OperatorChanged(operator, next);
        operator = next;
    }
}
