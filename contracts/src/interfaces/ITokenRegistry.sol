// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DataTypes} from "../libraries/DataTypes.sol";

interface ITokenRegistry {
    struct TokenConfig {
        address hubToken;
        address spokeToken;
        uint8 decimals;
        DataTypes.RiskParams risk;
        bytes32 bridgeAdapterId;
        bool enabled;
    }

    function getConfigByHub(address hubToken) external view returns (TokenConfig memory);
    function getHubTokenBySpoke(uint256 sourceChainId, address spokeToken) external view returns (address);
    function getSpokeTokenByHub(uint256 destinationChainId, address hubToken) external view returns (address);
    function getSpokeDecimalsByHub(uint256 destinationChainId, address hubToken) external view returns (uint8);
    function getSupportedAssets() external view returns (address[] memory);
}
