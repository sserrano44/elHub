// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/access/AccessControl.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {DataTypes} from "../libraries/DataTypes.sol";
import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";

contract TokenRegistry is AccessControl, Initializable, UUPSUpgradeable, ITokenRegistry {
    bytes32 public constant REGISTRY_ADMIN_ROLE = keccak256("REGISTRY_ADMIN_ROLE");

    enum TokenBehavior {
        UNSET,
        STANDARD,
        FEE_ON_TRANSFER,
        REBASING
    }

    mapping(address => TokenConfig) private _byHubToken;
    mapping(address => address) private _hubBySpoke;
    mapping(uint256 => mapping(address => address)) private _hubByChainSpoke;
    mapping(address => mapping(uint256 => address)) private _spokeByHubChain;
    mapping(address => mapping(uint256 => uint8)) private _spokeDecimalsByHubChain;
    address[] private _assets;
    mapping(address => bool) private _assetExists;
    mapping(address => TokenBehavior) public tokenBehaviorByToken;

    event TokenRegistered(
        address indexed hubToken,
        address indexed spokeToken,
        uint8 decimals,
        uint256 ltvBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationBonusBps,
        uint256 supplyCap,
        uint256 borrowCap,
        bytes32 bridgeAdapterId
    );

    event TokenUpdated(address indexed hubToken);
    event TokenRouteSet(uint256 indexed chainId, address indexed hubToken, address indexed spokeToken, uint8 spokeDecimals);
    event TokenBehaviorSet(address indexed token, TokenBehavior behavior);

    error InvalidTokenAddress();
    error InvalidChainId(uint256 chainId);
    error InvalidRiskParams();
    error InvalidTokenDecimals(uint8 decimals);
    error SpokeTokenAlreadyRegistered(address spokeToken, address hubToken);
    error SpokeTokenAlreadyRegisteredOnChain(uint256 chainId, address spokeToken, address hubToken);
    error TokenBehaviorNotConfigured(address token);
    error UnsupportedTokenBehavior(address token, TokenBehavior behavior);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRY_ADMIN_ROLE, admin);
        _disableInitializers();
    }

    function initializeProxy(address admin) external initializer {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRY_ADMIN_ROLE, admin);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function registerToken(TokenConfig calldata config) public onlyRole(REGISTRY_ADMIN_ROLE) {
        _registerToken(config);
    }

    function setTokenBehavior(address token, TokenBehavior behavior) external onlyRole(REGISTRY_ADMIN_ROLE) {
        if (token == address(0)) revert InvalidTokenAddress();
        tokenBehaviorByToken[token] = behavior;
        emit TokenBehaviorSet(token, behavior);
    }

    function registerTokenFlat(
        address hubToken,
        address spokeToken,
        uint8 decimals,
        uint256 ltvBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationBonusBps,
        uint256 supplyCap,
        uint256 borrowCap,
        bytes32 bridgeAdapterId,
        bool enabled
    ) external onlyRole(REGISTRY_ADMIN_ROLE) {
        TokenConfig memory config = TokenConfig({
            hubToken: hubToken,
            spokeToken: spokeToken,
            decimals: decimals,
            risk: DataTypes.RiskParams({
                ltvBps: ltvBps,
                liquidationThresholdBps: liquidationThresholdBps,
                liquidationBonusBps: liquidationBonusBps,
                supplyCap: supplyCap,
                borrowCap: borrowCap
            }),
            bridgeAdapterId: bridgeAdapterId,
            enabled: enabled
        });
        _registerToken(config);
    }

    function setTokenRoute(uint256 chainId, address hubToken, address spokeToken) external onlyRole(REGISTRY_ADMIN_ROLE) {
        TokenConfig storage cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();
        _setTokenRoute(chainId, hubToken, spokeToken, cfg.decimals);
    }

    function setTokenRoute(uint256 chainId, address hubToken, address spokeToken, uint8 spokeDecimals)
        external
        onlyRole(REGISTRY_ADMIN_ROLE)
    {
        _setTokenRoute(chainId, hubToken, spokeToken, spokeDecimals);
    }

    function _setTokenRoute(uint256 chainId, address hubToken, address spokeToken, uint8 spokeDecimals) internal {
        if (chainId == 0) revert InvalidChainId(chainId);
        if (hubToken == address(0) || spokeToken == address(0)) revert InvalidTokenAddress();
        if (spokeDecimals == 0 || spokeDecimals > 77) revert InvalidTokenDecimals(spokeDecimals);

        _requireSupportedTokenBehavior(hubToken);
        _requireSupportedTokenBehavior(spokeToken);

        TokenConfig storage cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();

        address previousSpoke = _spokeByHubChain[hubToken][chainId];
        if (previousSpoke != address(0) && previousSpoke != spokeToken) {
            delete _hubByChainSpoke[chainId][previousSpoke];
        }

        address existingHub = _hubByChainSpoke[chainId][spokeToken];
        if (existingHub != address(0) && existingHub != hubToken) {
            revert SpokeTokenAlreadyRegisteredOnChain(chainId, spokeToken, existingHub);
        }

        _spokeByHubChain[hubToken][chainId] = spokeToken;
        _hubByChainSpoke[chainId][spokeToken] = hubToken;
        _spokeDecimalsByHubChain[hubToken][chainId] = spokeDecimals;
        emit TokenRouteSet(chainId, hubToken, spokeToken, spokeDecimals);
    }

    function _registerToken(TokenConfig memory config) internal {
        if (config.hubToken == address(0) || config.spokeToken == address(0)) {
            revert InvalidTokenAddress();
        }
        if (config.decimals == 0 || config.decimals > 77) revert InvalidTokenDecimals(config.decimals);
        _requireSupportedTokenBehavior(config.hubToken);
        _requireSupportedTokenBehavior(config.spokeToken);
        _validateRisk(config.risk);

        TokenConfig storage previous = _byHubToken[config.hubToken];
        if (previous.hubToken != address(0) && previous.spokeToken != address(0) && previous.spokeToken != config.spokeToken) {
            delete _hubBySpoke[previous.spokeToken];
        }

        address existingHub = _hubBySpoke[config.spokeToken];
        if (existingHub != address(0) && existingHub != config.hubToken) {
            revert SpokeTokenAlreadyRegistered(config.spokeToken, existingHub);
        }

        _byHubToken[config.hubToken] = config;
        _hubBySpoke[config.spokeToken] = config.hubToken;

        if (!_assetExists[config.hubToken]) {
            _assetExists[config.hubToken] = true;
            _assets.push(config.hubToken);
        }

        emit TokenRegistered(
            config.hubToken,
            config.spokeToken,
            config.decimals,
            config.risk.ltvBps,
            config.risk.liquidationThresholdBps,
            config.risk.liquidationBonusBps,
            config.risk.supplyCap,
            config.risk.borrowCap,
            config.bridgeAdapterId
        );
    }

    function updateRisk(address hubToken, DataTypes.RiskParams calldata risk)
        external
        onlyRole(REGISTRY_ADMIN_ROLE)
    {
        TokenConfig storage cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();
        _validateRisk(risk);
        cfg.risk = risk;
        emit TokenUpdated(hubToken);
    }

    function setBridgeAdapterId(address hubToken, bytes32 bridgeAdapterId)
        external
        onlyRole(REGISTRY_ADMIN_ROLE)
    {
        TokenConfig storage cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();
        cfg.bridgeAdapterId = bridgeAdapterId;
        emit TokenUpdated(hubToken);
    }

    function setEnabled(address hubToken, bool enabled) external onlyRole(REGISTRY_ADMIN_ROLE) {
        TokenConfig storage cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();
        cfg.enabled = enabled;
        emit TokenUpdated(hubToken);
    }

    function getConfigByHub(address hubToken) external view returns (TokenConfig memory) {
        return _byHubToken[hubToken];
    }

    function getHubTokenBySpoke(uint256 sourceChainId, address spokeToken) external view returns (address) {
        address byChain = _hubByChainSpoke[sourceChainId][spokeToken];
        if (byChain != address(0)) return byChain;
        return _hubBySpoke[spokeToken];
    }

    function getSpokeTokenByHub(uint256 destinationChainId, address hubToken) external view returns (address) {
        address byChain = _spokeByHubChain[hubToken][destinationChainId];
        if (byChain != address(0)) return byChain;
        return _byHubToken[hubToken].spokeToken;
    }

    function getSpokeDecimalsByHub(uint256 destinationChainId, address hubToken) external view returns (uint8) {
        TokenConfig memory cfg = _byHubToken[hubToken];
        if (cfg.hubToken == address(0)) revert InvalidTokenAddress();

        uint8 byChain = _spokeDecimalsByHubChain[hubToken][destinationChainId];
        if (byChain != 0) return byChain;
        return cfg.decimals;
    }

    function getSupportedAssets() external view returns (address[] memory) {
        return _assets;
    }

    function _validateRisk(DataTypes.RiskParams memory risk) private pure {
        if (
            risk.ltvBps > 10_000 || risk.liquidationThresholdBps > 10_000
                || risk.ltvBps > risk.liquidationThresholdBps || risk.liquidationBonusBps < 10_000
        ) {
            revert InvalidRiskParams();
        }
    }

    function _requireSupportedTokenBehavior(address token) private view {
        TokenBehavior behavior = tokenBehaviorByToken[token];
        if (behavior == TokenBehavior.UNSET) revert TokenBehaviorNotConfigured(token);
        if (behavior != TokenBehavior.STANDARD) revert UnsupportedTokenBehavior(token, behavior);
    }
}
