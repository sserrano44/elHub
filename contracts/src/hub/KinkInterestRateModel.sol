// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {Constants} from "../libraries/Constants.sol";
import {MulDiv} from "../libraries/MulDiv.sol";
import {IInterestRateModel} from "../interfaces/IInterestRateModel.sol";

contract KinkInterestRateModel is Ownable, Initializable, UUPSUpgradeable, IInterestRateModel {
    struct RateConfig {
        uint256 baseRatePerSecondRay;
        uint256 slope1PerSecondRay;
        uint256 slope2PerSecondRay;
        uint256 kinkUtilizationRay;
        uint256 reserveFactorRay;
    }

    RateConfig public defaultConfig;
    mapping(address => RateConfig) public assetConfig;

    event AssetRateConfigSet(address indexed asset);
    event DefaultRateConfigSet();

    error InvalidRateConfig();

    constructor(
        address admin,
        uint256 baseRatePerSecondRay,
        uint256 slope1PerSecondRay,
        uint256 slope2PerSecondRay,
        uint256 kinkUtilizationRay,
        uint256 reserveFactorRay
    ) Ownable(admin) {
        RateConfig memory config = RateConfig({
            baseRatePerSecondRay: baseRatePerSecondRay,
            slope1PerSecondRay: slope1PerSecondRay,
            slope2PerSecondRay: slope2PerSecondRay,
            kinkUtilizationRay: kinkUtilizationRay,
            reserveFactorRay: reserveFactorRay
        });
        _validateConfig(config);
        defaultConfig = config;
        _disableInitializers();
    }

    function initializeProxy(
        address admin,
        uint256 baseRatePerSecondRay,
        uint256 slope1PerSecondRay,
        uint256 slope2PerSecondRay,
        uint256 kinkUtilizationRay,
        uint256 reserveFactorRay
    ) external initializer {
        if (admin == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(admin);

        RateConfig memory config = RateConfig({
            baseRatePerSecondRay: baseRatePerSecondRay,
            slope1PerSecondRay: slope1PerSecondRay,
            slope2PerSecondRay: slope2PerSecondRay,
            kinkUtilizationRay: kinkUtilizationRay,
            reserveFactorRay: reserveFactorRay
        });
        _validateConfig(config);
        defaultConfig = config;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setDefaultConfig(RateConfig calldata config) external onlyOwner {
        _validateConfig(config);
        defaultConfig = config;
        emit DefaultRateConfigSet();
    }

    function setAssetConfig(address asset, RateConfig calldata config) external onlyOwner {
        _validateConfig(config);
        assetConfig[asset] = config;
        emit AssetRateConfigSet(asset);
    }

    function getBorrowRate(address asset, uint256 utilizationRay) external view returns (uint256) {
        RateConfig memory config = _getConfig(asset);
        return _borrowRate(config, utilizationRay);
    }

    function getSupplyRate(address asset, uint256 utilizationRay) external view returns (uint256) {
        RateConfig memory config = _getConfig(asset);
        uint256 borrowRate = _borrowRate(config, utilizationRay);
        uint256 grossSupplyRateRay = MulDiv.mulDiv(borrowRate, utilizationRay, Constants.RAY);
        return MulDiv.mulDiv(grossSupplyRateRay, Constants.RAY - config.reserveFactorRay, Constants.RAY);
    }

    function _getConfig(address asset) private view returns (RateConfig memory config) {
        config = assetConfig[asset];
        if (config.kinkUtilizationRay == 0) {
            config = defaultConfig;
        }
    }

    function _borrowRate(RateConfig memory config, uint256 util) private pure returns (uint256) {
        if (util <= config.kinkUtilizationRay) {
            return config.baseRatePerSecondRay + (util * config.slope1PerSecondRay / config.kinkUtilizationRay);
        }
        uint256 excessUtil = util - config.kinkUtilizationRay;
        uint256 maxExcess = Constants.RAY - config.kinkUtilizationRay;
        return config.baseRatePerSecondRay + config.slope1PerSecondRay
            + (excessUtil * config.slope2PerSecondRay / maxExcess);
    }

    function _validateConfig(RateConfig memory config) private pure {
        if (config.kinkUtilizationRay == 0 || config.kinkUtilizationRay >= Constants.RAY) {
            revert InvalidRateConfig();
        }
        if (config.reserveFactorRay > Constants.RAY) revert InvalidRateConfig();
    }
}
