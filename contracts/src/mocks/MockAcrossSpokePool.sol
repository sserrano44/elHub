// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";

interface IAcrossMessageHandlerV3 {
    function handleV3AcrossMessage(address tokenSent, uint256 amountReceived, address relayer, bytes calldata message)
        external;
}

/// @notice Local Across SpokePool mock used for source deposits and hub relay simulation.
contract MockAcrossSpokePool {
    using SafeERC20 for IERC20;

    uint256 public nextDepositId;
    mapping(bytes32 => bool) public usedRelay;

    event V3FundsDeposited(
        uint256 indexed depositId,
        address indexed depositor,
        address indexed recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes message,
        address caller
    );

    event V3RelayFilled(
        bytes32 indexed relayKey,
        uint256 indexed originChainId,
        bytes32 indexed originTxHash,
        uint256 originLogIndex,
        address outputToken,
        uint256 amount,
        address recipient,
        address relayer,
        bytes message,
        address caller
    );

    error InvalidAmount();
    error InvalidRecipient(address recipient);
    error InvalidOutputToken(address token);
    error RelayAlreadyUsed(bytes32 relayKey);

    function depositV3(
        address depositor,
        address recipient,
        address inputToken,
        address outputToken,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 destinationChainId,
        address exclusiveRelayer,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        uint32 exclusivityDeadline,
        bytes calldata message
    ) external payable {
        if (recipient == address(0)) revert InvalidRecipient(recipient);
        if (inputAmount == 0 || outputAmount == 0) revert InvalidAmount();

        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), inputAmount);

        uint256 depositId = ++nextDepositId;
        emit V3FundsDeposited(
            depositId,
            depositor,
            recipient,
            inputToken,
            outputToken,
            inputAmount,
            outputAmount,
            destinationChainId,
            exclusiveRelayer,
            quoteTimestamp,
            fillDeadline,
            exclusivityDeadline,
            message,
            msg.sender
        );
    }

    function relayV3Deposit(
        uint256 originChainId,
        bytes32 originTxHash,
        uint256 originLogIndex,
        address outputToken,
        uint256 outputAmount,
        address recipient,
        bytes calldata message
    ) external {
        if (recipient == address(0)) revert InvalidRecipient(recipient);
        if (outputToken == address(0)) revert InvalidOutputToken(outputToken);
        if (outputAmount == 0) revert InvalidAmount();

        bytes32 relayKey = keccak256(
            abi.encode(originChainId, originTxHash, originLogIndex, outputToken, outputAmount, recipient, keccak256(message))
        );
        if (usedRelay[relayKey]) revert RelayAlreadyUsed(relayKey);
        usedRelay[relayKey] = true;

        IERC20(outputToken).safeTransfer(recipient, outputAmount);

        if (message.length > 0 && recipient.code.length > 0) {
            IAcrossMessageHandlerV3(recipient).handleV3AcrossMessage(outputToken, outputAmount, msg.sender, message);
        }

        emit V3RelayFilled(
            relayKey,
            originChainId,
            originTxHash,
            originLogIndex,
            outputToken,
            outputAmount,
            recipient,
            msg.sender,
            message,
            msg.sender
        );
    }
}
