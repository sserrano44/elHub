// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {Constants} from "../libraries/Constants.sol";
import {DataTypes} from "../libraries/DataTypes.sol";
import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";
import {IHubMoneyMarket} from "../interfaces/IHubMoneyMarket.sol";
import {IHubLockManager} from "../interfaces/IHubLockManager.sol";
import {IHubRiskManager} from "../interfaces/IHubRiskManager.sol";
import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract HubRiskManager is Ownable, Initializable, UUPSUpgradeable, IHubRiskManager {
    uint256 internal constant DEFAULT_MIN_ORACLE_PRICE_E8 = 1;
    uint256 internal constant DEFAULT_MAX_ORACLE_PRICE_E8 = type(uint256).max;

    ITokenRegistry public immutable tokenRegistry;
    IHubMoneyMarket public immutable moneyMarket;
    IPriceOracle public immutable oracle;

    address public lockManager;
    uint256 public minOraclePriceE8;
    uint256 public maxOraclePriceE8;

    mapping(address => DataTypes.RiskParams) public riskParams;

    event LockManagerSet(address indexed lockManager);
    event OracleBoundsSet(uint256 minPriceE8, uint256 maxPriceE8);
    event RiskParamsSet(
        address indexed asset,
        uint256 ltvBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationBonusBps,
        uint256 supplyCap,
        uint256 borrowCap
    );

    error InvalidRiskParams();
    error InvalidLockManager(address lockManager);
    error InvalidOracleBounds(uint256 minPriceE8, uint256 maxPriceE8);
    error InvalidOraclePrice(address asset, uint256 priceE8);

    constructor(address owner_, ITokenRegistry tokenRegistry_, IHubMoneyMarket moneyMarket_, IPriceOracle oracle_)
        Ownable(owner_)
    {
        tokenRegistry = tokenRegistry_;
        moneyMarket = moneyMarket_;
        oracle = oracle_;
        minOraclePriceE8 = DEFAULT_MIN_ORACLE_PRICE_E8;
        maxOraclePriceE8 = DEFAULT_MAX_ORACLE_PRICE_E8;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
        minOraclePriceE8 = DEFAULT_MIN_ORACLE_PRICE_E8;
        maxOraclePriceE8 = DEFAULT_MAX_ORACLE_PRICE_E8;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setLockManager(address lockManager_) external onlyOwner {
        if (lockManager_ == address(0)) revert InvalidLockManager(lockManager_);
        lockManager = lockManager_;
        emit LockManagerSet(lockManager_);
    }

    function setOracleBounds(uint256 minPriceE8, uint256 maxPriceE8) external onlyOwner {
        if (minPriceE8 == 0 || maxPriceE8 < minPriceE8) revert InvalidOracleBounds(minPriceE8, maxPriceE8);
        minOraclePriceE8 = minPriceE8;
        maxOraclePriceE8 = maxPriceE8;
        emit OracleBoundsSet(minPriceE8, maxPriceE8);
    }

    function setRiskParams(address asset, DataTypes.RiskParams calldata params) external onlyOwner {
        _setRiskParams(asset, params);
    }

    function setRiskParamsFlat(
        address asset,
        uint256 ltvBps,
        uint256 liquidationThresholdBps,
        uint256 liquidationBonusBps,
        uint256 supplyCap,
        uint256 borrowCap
    ) external onlyOwner {
        _setRiskParams(
            asset,
            DataTypes.RiskParams({
                ltvBps: ltvBps,
                liquidationThresholdBps: liquidationThresholdBps,
                liquidationBonusBps: liquidationBonusBps,
                supplyCap: supplyCap,
                borrowCap: borrowCap
            })
        );
    }

    function _setRiskParams(address asset, DataTypes.RiskParams memory params) internal {
        if (
            params.ltvBps > Constants.BPS || params.liquidationThresholdBps > Constants.BPS
                || params.ltvBps > params.liquidationThresholdBps || params.liquidationBonusBps < Constants.BPS
        ) {
            revert InvalidRiskParams();
        }
        riskParams[asset] = params;
        emit RiskParamsSet(
            asset,
            params.ltvBps,
            params.liquidationThresholdBps,
            params.liquidationBonusBps,
            params.supplyCap,
            params.borrowCap
        );
    }

    function canLockBorrow(address user, address asset, uint256 amount) external view returns (bool) {
        if (!_isAssetEnabled(asset)) return false;
        if (!_withinBorrowCap(asset, amount)) return false;
        uint256 hf = _healthFactorAfter(user, asset, amount, address(0), 0, true);
        return hf >= Constants.WAD;
    }

    function canLockWithdraw(address user, address asset, uint256 amount) external view returns (bool) {
        if (!_isAssetRegistered(asset)) return false;
        if (!_withinSupplyCap(asset, 0)) return false;
        uint256 hf = _healthFactorAfter(user, address(0), 0, asset, amount, true);
        return hf >= Constants.WAD;
    }

    function canUserSupply(address asset, uint256 amount) external view returns (bool) {
        if (!_isAssetEnabled(asset)) return false;
        return _withinSupplyCap(asset, amount);
    }

    function canUserBorrow(address user, address asset, uint256 amount) external view returns (bool) {
        if (!_isAssetEnabled(asset)) return false;
        if (!_withinBorrowCap(asset, amount)) return false;
        uint256 hf = _healthFactorAfter(user, asset, amount, address(0), 0, true);
        return hf >= Constants.WAD;
    }

    function canUserWithdraw(address user, address asset, uint256 amount) external view returns (bool) {
        if (!_isAssetRegistered(asset)) return false;
        if (!_withinSupplyCap(asset, 0)) return false;
        uint256 hf = _healthFactorAfter(user, address(0), 0, asset, amount, true);
        return hf >= Constants.WAD;
    }

    function healthFactor(address user) external view returns (uint256) {
        return _healthFactorAfter(user, address(0), 0, address(0), 0, true);
    }

    function isLiquidatable(address user) external view returns (bool) {
        uint256 hf = _healthFactorAfter(user, address(0), 0, address(0), 0, false);
        return hf < Constants.WAD;
    }

    function getAssetPriceE8(address asset) external view returns (uint256) {
        return _priceE8(asset);
    }

    function getLiquidationBonusBps(address asset) external view returns (uint256) {
        return _risk(asset).liquidationBonusBps;
    }

    function _healthFactorAfter(
        address user,
        address borrowAsset,
        uint256 borrowDelta,
        address withdrawAsset,
        uint256 withdrawDelta,
        bool includeReservations
    ) internal view returns (uint256) {
        address[] memory assets = tokenRegistry.getSupportedAssets();

        uint256 adjustedCollateralValue;
        uint256 totalDebtValue;

        for (uint256 i = 0; i < assets.length; i++) {
            address asset = assets[i];
            ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfigByHub(asset);
            if (!cfg.enabled) continue;

            uint256 decimalsFactor = 10 ** cfg.decimals;
            uint256 priceE8 = _priceE8(asset);

            uint256 supplyAmount = moneyMarket.getUserSupply(user, asset);
            uint256 debtAmount = moneyMarket.getUserDebt(user, asset);

            if (includeReservations && lockManager != address(0)) {
                supplyAmount -= _min(supplyAmount, IHubLockManager(lockManager).reservedWithdraw(user, asset));
                debtAmount += IHubLockManager(lockManager).reservedDebt(user, asset);
            }

            if (asset == borrowAsset) {
                debtAmount += borrowDelta;
            }
            if (asset == withdrawAsset) {
                supplyAmount -= _min(supplyAmount, withdrawDelta);
            }

            DataTypes.RiskParams memory risk = _risk(asset);
            uint256 adjustedPriceE8 = priceE8 * risk.liquidationThresholdBps / Constants.BPS;
            adjustedCollateralValue += supplyAmount * adjustedPriceE8 / decimalsFactor;
            totalDebtValue += debtAmount * priceE8 / decimalsFactor;
        }

        if (totalDebtValue == 0) {
            return type(uint256).max;
        }
        return adjustedCollateralValue * Constants.WAD / totalDebtValue;
    }

    function _risk(address asset) internal view returns (DataTypes.RiskParams memory params) {
        params = riskParams[asset];
        if (params.liquidationThresholdBps == 0) {
            params = tokenRegistry.getConfigByHub(asset).risk;
        }
    }

    function _withinSupplyCap(address asset, uint256 deltaSupply) internal view returns (bool) {
        DataTypes.RiskParams memory risk = _risk(asset);
        if (risk.supplyCap == 0) return true;
        return moneyMarket.totalSupplyAssets(asset) + deltaSupply <= risk.supplyCap;
    }

    function _withinBorrowCap(address asset, uint256 deltaBorrow) internal view returns (bool) {
        DataTypes.RiskParams memory risk = _risk(asset);
        if (risk.borrowCap == 0) return true;
        return moneyMarket.totalDebtAssets(asset) + deltaBorrow <= risk.borrowCap;
    }

    function _isAssetRegistered(address asset) internal view returns (bool) {
        return tokenRegistry.getConfigByHub(asset).hubToken != address(0);
    }

    function _isAssetEnabled(address asset) internal view returns (bool) {
        ITokenRegistry.TokenConfig memory cfg = tokenRegistry.getConfigByHub(asset);
        return cfg.hubToken != address(0) && cfg.enabled;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _priceE8(address asset) internal view returns (uint256 priceE8) {
        priceE8 = oracle.getPrice(asset);
        if (priceE8 < minOraclePriceE8 || priceE8 > maxOraclePriceE8) {
            revert InvalidOraclePrice(asset, priceE8);
        }
    }
}
