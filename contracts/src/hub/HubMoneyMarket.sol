// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/access/Ownable.sol";
import {Initializable} from "@openzeppelin-contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin-contracts/proxy/utils/UUPSUpgradeable.sol";
import {Pausable} from "@openzeppelin/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Constants} from "../libraries/Constants.sol";
import {ITokenRegistry} from "../interfaces/ITokenRegistry.sol";
import {IInterestRateModel} from "../interfaces/IInterestRateModel.sol";
import {IHubRiskManager} from "../interfaces/IHubRiskManager.sol";
import {IHubMoneyMarket} from "../interfaces/IHubMoneyMarket.sol";

contract HubMoneyMarket is Ownable, Initializable, UUPSUpgradeable, Pausable, ReentrancyGuard, IHubMoneyMarket {
    using SafeERC20 for IERC20;

    struct Market {
        uint256 totalSupplyShares;
        uint256 totalDebtShares;
        uint256 supplyIndex;
        uint256 borrowIndex;
        uint256 reserves;
        uint40 lastAccrual;
        bool initialized;
    }

    ITokenRegistry public immutable tokenRegistry;
    IInterestRateModel public immutable rateModel;

    address public riskManager;
    address public settlement;

    mapping(address => Market) public markets;
    mapping(address user => mapping(address asset => uint256)) public supplyShares;
    mapping(address user => mapping(address asset => uint256)) public debtShares;

    event MarketInitialized(address indexed asset);
    event RiskManagerSet(address indexed riskManager);
    event SettlementSet(address indexed settlement);

    event InterestAccrued(
        address indexed asset,
        uint256 borrowIndex,
        uint256 supplyIndex,
        uint256 totalDebt,
        uint256 totalSupply,
        uint256 reserves
    );

    event Supplied(address indexed caller, address indexed onBehalfOf, address indexed asset, uint256 amount);
    event Withdrawn(address indexed caller, address indexed receiver, address indexed asset, uint256 amount);
    event Borrowed(address indexed caller, address indexed receiver, address indexed asset, uint256 amount);
    event Repaid(address indexed caller, address indexed onBehalfOf, address indexed asset, uint256 amount);
    event Liquidated(
        address indexed liquidator,
        address indexed user,
        address debtAsset,
        address collateralAsset,
        uint256 repaid,
        uint256 seizedCollateral
    );

    event SettlementSupplyCredited(address indexed user, address indexed asset, uint256 amount);
    event SettlementRepayCredited(address indexed user, address indexed asset, uint256 amount);
    event SettlementRepaySurplusRefunded(address indexed user, address indexed asset, uint256 amount);
    event SettlementBorrowFinalized(address indexed user, address indexed asset, uint256 amount, address relayer, uint256 fee);
    event SettlementWithdrawFinalized(address indexed user, address indexed asset, uint256 amount, address relayer, uint256 fee);

    error MarketNotInitialized(address asset);
    error MarketAlreadyInitialized(address asset);
    error InvalidAmount();
    error NotSettlement(address caller);
    error InsufficientLiquidity(address asset, uint256 requested, uint256 available);
    error SupplyNotAllowed();
    error BorrowNotAllowed();
    error WithdrawNotAllowed();
    error NotLiquidatable();
    error InvalidRiskManager(address riskManager);
    error InvalidSettlement(address settlement);

    modifier onlySettlement() {
        if (msg.sender != settlement) revert NotSettlement(msg.sender);
        _;
    }

    constructor(address owner_, ITokenRegistry tokenRegistry_, IInterestRateModel rateModel_) Ownable(owner_) {
        tokenRegistry = tokenRegistry_;
        rateModel = rateModel_;
        _disableInitializers();
    }

    function initializeProxy(address owner_) external initializer {
        if (owner_ == address(0)) revert OwnableInvalidOwner(address(0));
        _transferOwnership(owner_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function initializeMarket(address asset) external onlyOwner {
        Market storage market = markets[asset];
        if (market.initialized) revert MarketAlreadyInitialized(asset);
        market.supplyIndex = Constants.RAY;
        market.borrowIndex = Constants.RAY;
        market.lastAccrual = uint40(block.timestamp);
        market.initialized = true;
        emit MarketInitialized(asset);
    }

    function setRiskManager(address riskManager_) external onlyOwner {
        if (riskManager_ == address(0)) revert InvalidRiskManager(riskManager_);
        riskManager = riskManager_;
        emit RiskManagerSet(riskManager_);
    }

    function setSettlement(address settlement_) external onlyOwner {
        if (settlement_ == address(0)) revert InvalidSettlement(settlement_);
        settlement = settlement_;
        emit SettlementSet(settlement_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function accrueInterest(address asset) public {
        // Interest accrues lazily per asset. Every state-mutating path calls accrue first.
        Market storage market = markets[asset];
        if (!market.initialized) revert MarketNotInitialized(asset);

        uint256 elapsed = block.timestamp - market.lastAccrual;
        if (elapsed == 0) return;

        uint256 debtAssets = _assetsFromShares(market.totalDebtShares, market.borrowIndex);
        uint256 supplyAssets_ = _assetsFromShares(market.totalSupplyShares, market.supplyIndex);

        if (debtAssets == 0 || supplyAssets_ == 0) {
            market.lastAccrual = uint40(block.timestamp);
            emit InterestAccrued(asset, market.borrowIndex, market.supplyIndex, debtAssets, supplyAssets_, market.reserves);
            return;
        }

        // Utilization-driven kink model rates.
        uint256 utilizationRay = debtAssets * Constants.RAY / supplyAssets_;
        uint256 borrowRate = rateModel.getBorrowRate(asset, utilizationRay);
        uint256 supplyRate = rateModel.getSupplyRate(asset, utilizationRay);

        uint256 borrowFactor = Constants.RAY + (borrowRate * elapsed);
        uint256 supplyFactor = Constants.RAY + (supplyRate * elapsed);

        uint256 newBorrowIndex = market.borrowIndex * borrowFactor / Constants.RAY;
        uint256 newSupplyIndex = market.supplyIndex * supplyFactor / Constants.RAY;

        uint256 debtInterest = debtAssets * borrowRate * elapsed / Constants.RAY;
        uint256 supplyInterest = supplyAssets_ * supplyRate * elapsed / Constants.RAY;

        if (debtInterest > supplyInterest) {
            market.reserves += (debtInterest - supplyInterest);
        }

        market.borrowIndex = newBorrowIndex;
        market.supplyIndex = newSupplyIndex;
        market.lastAccrual = uint40(block.timestamp);

        emit InterestAccrued(
            asset,
            newBorrowIndex,
            newSupplyIndex,
            _assetsFromShares(market.totalDebtShares, newBorrowIndex),
            _assetsFromShares(market.totalSupplyShares, newSupplyIndex),
            market.reserves
        );
    }

    function supply(address asset, uint256 amount, address onBehalfOf) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserSupply(asset, amount)) {
            revert SupplyNotAllowed();
        }

        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        Market storage market = markets[asset];
        uint256 mintedShares = _sharesFromAssets(amount, market.supplyIndex, false);
        market.totalSupplyShares += mintedShares;
        supplyShares[onBehalfOf][asset] += mintedShares;

        emit Supplied(msg.sender, onBehalfOf, asset, amount);
    }

    function repay(address asset, uint256 amount, address onBehalfOf) external nonReentrant whenNotPaused returns (uint256 repaidAmount) {
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        Market storage market = markets[asset];
        uint256 userDebtShares = debtShares[onBehalfOf][asset];
        if (userDebtShares == 0) return 0;

        uint256 sharesToBurn = _sharesFromAssets(amount, market.borrowIndex, false);
        if (sharesToBurn > userDebtShares) {
            sharesToBurn = userDebtShares;
        }

        repaidAmount = _assetsFromShares(sharesToBurn, market.borrowIndex);

        debtShares[onBehalfOf][asset] = userDebtShares - sharesToBurn;
        market.totalDebtShares -= sharesToBurn;

        IERC20(asset).safeTransferFrom(msg.sender, address(this), repaidAmount);
        emit Repaid(msg.sender, onBehalfOf, asset, repaidAmount);
    }

    function borrow(address asset, uint256 amount, address receiver) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserBorrow(msg.sender, asset, amount)) {
            revert BorrowNotAllowed();
        }

        uint256 liquidity = availableLiquidity(asset);
        if (liquidity < amount) revert InsufficientLiquidity(asset, amount, liquidity);

        Market storage market = markets[asset];
        uint256 mintedDebtShares = _sharesFromAssets(amount, market.borrowIndex, true);
        market.totalDebtShares += mintedDebtShares;
        debtShares[msg.sender][asset] += mintedDebtShares;

        IERC20(asset).safeTransfer(receiver, amount);
        emit Borrowed(msg.sender, receiver, asset, amount);
    }

    function withdraw(address asset, uint256 amount, address receiver) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserWithdraw(msg.sender, asset, amount)) {
            revert WithdrawNotAllowed();
        }

        Market storage market = markets[asset];
        uint256 burnShares = _sharesFromAssets(amount, market.supplyIndex, true);
        uint256 userShares = supplyShares[msg.sender][asset];
        require(userShares >= burnShares, "INSUFFICIENT_SUPPLY_SHARES");

        supplyShares[msg.sender][asset] = userShares - burnShares;
        market.totalSupplyShares -= burnShares;

        uint256 liquidity = availableLiquidity(asset);
        if (liquidity < amount) revert InsufficientLiquidity(asset, amount, liquidity);

        IERC20(asset).safeTransfer(receiver, amount);
        emit Withdrawn(msg.sender, receiver, asset, amount);
    }

    function liquidate(
        address user,
        address debtAsset,
        uint256 repayAmount,
        address collateralAsset
    ) external nonReentrant whenNotPaused {
        if (repayAmount == 0) revert InvalidAmount();
        accrueInterest(debtAsset);
        accrueInterest(collateralAsset);

        if (riskManager == address(0) || !IHubRiskManager(riskManager).isLiquidatable(user)) {
            revert NotLiquidatable();
        }

        Market storage debtMarket = markets[debtAsset];
        Market storage collateralMarket = markets[collateralAsset];

        uint256 userDebtShares = debtShares[user][debtAsset];
        uint256 debtSharesToBurn = _sharesFromAssets(repayAmount, debtMarket.borrowIndex, false);
        if (debtSharesToBurn > userDebtShares) {
            debtSharesToBurn = userDebtShares;
        }

        uint256 actualRepay = _assetsFromShares(debtSharesToBurn, debtMarket.borrowIndex);
        IERC20(debtAsset).safeTransferFrom(msg.sender, address(this), actualRepay);

        debtShares[user][debtAsset] = userDebtShares - debtSharesToBurn;
        debtMarket.totalDebtShares -= debtSharesToBurn;

        uint256 debtPrice = IHubRiskManager(riskManager).getAssetPriceE8(debtAsset);
        uint256 collateralPrice = IHubRiskManager(riskManager).getAssetPriceE8(collateralAsset);
        uint256 liquidationBonusBps = IHubRiskManager(riskManager).getLiquidationBonusBps(collateralAsset);

        uint256 collateralAmount = _quoteCollateralAmount(
            debtAsset,
            collateralAsset,
            actualRepay,
            debtPrice,
            collateralPrice,
            liquidationBonusBps
        );
        (uint256 collateralSharesToBurn, uint256 userCollateralShares, uint256 adjustedCollateralAmount) =
            _boundCollateralByUserShares(user, collateralAsset, collateralAmount, collateralMarket.supplyIndex);

        supplyShares[user][collateralAsset] = userCollateralShares - collateralSharesToBurn;
        collateralMarket.totalSupplyShares -= collateralSharesToBurn;

        IERC20(collateralAsset).safeTransfer(msg.sender, adjustedCollateralAmount);

        emit Liquidated(msg.sender, user, debtAsset, collateralAsset, actualRepay, adjustedCollateralAmount);
    }

    function settlementCreditSupply(address user, address asset, uint256 amount)
        external
        onlySettlement
        whenNotPaused
    {
        // Settlement-only path: supply is credited only after bridge delivery + batch proof.
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserSupply(asset, amount)) {
            revert SupplyNotAllowed();
        }

        Market storage market = markets[asset];
        uint256 mintedShares = _sharesFromAssets(amount, market.supplyIndex, false);
        market.totalSupplyShares += mintedShares;
        supplyShares[user][asset] += mintedShares;

        emit SettlementSupplyCredited(user, asset, amount);
    }

    function settlementCreditRepay(address user, address asset, uint256 amount)
        external
        onlySettlement
        whenNotPaused
        returns (uint256 actualRepay)
    {
        // Settlement-only path: debt reduction is applied after bridged repay is finalized.
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        Market storage market = markets[asset];
        uint256 userDebt = debtShares[user][asset];
        if (userDebt == 0) {
            return 0;
        }

        uint256 burnShares = _sharesFromAssets(amount, market.borrowIndex, false);
        if (burnShares > userDebt) {
            burnShares = userDebt;
        }

        actualRepay = _assetsFromShares(burnShares, market.borrowIndex);
        debtShares[user][asset] = userDebt - burnShares;
        market.totalDebtShares -= burnShares;

        emit SettlementRepayCredited(user, asset, actualRepay);
    }

    function settlementRefund(address asset, address recipient, uint256 amount) external onlySettlement whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        IERC20(asset).safeTransfer(recipient, amount);
        emit SettlementRepaySurplusRefunded(recipient, asset, amount);
    }

    function settlementFinalizeBorrow(address user, address asset, uint256 amount, address relayer, uint256 fee)
        external
        onlySettlement
        whenNotPaused
    {
        // Borrow finalization mints user debt and reimburses relayer on hub.
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserBorrow(user, asset, amount)) {
            revert BorrowNotAllowed();
        }

        uint256 liquidity = availableLiquidity(asset);
        if (liquidity < amount) revert InsufficientLiquidity(asset, amount, liquidity);

        Market storage market = markets[asset];
        uint256 mintedDebtShares = _sharesFromAssets(amount, market.borrowIndex, true);
        market.totalDebtShares += mintedDebtShares;
        debtShares[user][asset] += mintedDebtShares;

        IERC20(asset).safeTransfer(relayer, amount);
        emit SettlementBorrowFinalized(user, asset, amount, relayer, fee);
    }

    function settlementFinalizeWithdraw(address user, address asset, uint256 amount, address relayer, uint256 fee)
        external
        onlySettlement
        whenNotPaused
    {
        // Withdraw finalization burns collateral shares and reimburses relayer on hub.
        if (amount == 0) revert InvalidAmount();
        accrueInterest(asset);

        if (riskManager != address(0) && !IHubRiskManager(riskManager).canUserWithdraw(user, asset, amount)) {
            revert WithdrawNotAllowed();
        }

        Market storage market = markets[asset];
        uint256 burnShares = _sharesFromAssets(amount, market.supplyIndex, true);
        uint256 userShares = supplyShares[user][asset];
        require(userShares >= burnShares, "INSUFFICIENT_SUPPLY_SHARES");

        supplyShares[user][asset] = userShares - burnShares;
        market.totalSupplyShares -= burnShares;

        uint256 liquidity = availableLiquidity(asset);
        if (liquidity < amount) revert InsufficientLiquidity(asset, amount, liquidity);

        IERC20(asset).safeTransfer(relayer, amount);
        emit SettlementWithdrawFinalized(user, asset, amount, relayer, fee);
    }

    function getUserSupply(address user, address asset) external view returns (uint256) {
        Market storage market = markets[asset];
        if (!market.initialized) return 0;
        return _assetsFromShares(supplyShares[user][asset], market.supplyIndex);
    }

    function getUserDebt(address user, address asset) external view returns (uint256) {
        Market storage market = markets[asset];
        if (!market.initialized) return 0;
        return _assetsFromShares(debtShares[user][asset], market.borrowIndex);
    }

    function totalSupplyAssets(address asset) public view returns (uint256) {
        Market storage market = markets[asset];
        if (!market.initialized) return 0;
        return _assetsFromShares(market.totalSupplyShares, market.supplyIndex);
    }

    function totalDebtAssets(address asset) public view returns (uint256) {
        Market storage market = markets[asset];
        if (!market.initialized) return 0;
        return _assetsFromShares(market.totalDebtShares, market.borrowIndex);
    }

    function availableLiquidity(address asset) public view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    function _assetsFromShares(uint256 shares, uint256 index) internal pure returns (uint256) {
        return shares * index / Constants.RAY;
    }

    function _sharesFromAssets(uint256 assets, uint256 index, bool roundUp) internal pure returns (uint256) {
        uint256 raw = assets * Constants.RAY;
        uint256 shares = raw / index;
        if (roundUp && raw % index != 0) {
            shares += 1;
        }
        return shares;
    }

    function _quoteCollateralAmount(
        address debtAsset,
        address collateralAsset,
        uint256 repayAmount,
        uint256 debtPriceE8,
        uint256 collateralPriceE8,
        uint256 liquidationBonusBps
    ) internal view returns (uint256) {
        uint8 debtDecimals = ITokenRegistry(tokenRegistry).getConfigByHub(debtAsset).decimals;
        uint8 collateralDecimals = ITokenRegistry(tokenRegistry).getConfigByHub(collateralAsset).decimals;

        uint256 debtValueWithBonusE8 =
            repayAmount * debtPriceE8 * liquidationBonusBps / ((10 ** debtDecimals) * Constants.BPS);
        return debtValueWithBonusE8 * (10 ** collateralDecimals) / collateralPriceE8;
    }

    function _boundCollateralByUserShares(
        address user,
        address collateralAsset,
        uint256 collateralAmount,
        uint256 supplyIndex
    ) internal view returns (uint256 collateralSharesToBurn, uint256 userCollateralShares, uint256 adjustedAmount) {
        collateralSharesToBurn = _sharesFromAssets(collateralAmount, supplyIndex, true);
        userCollateralShares = supplyShares[user][collateralAsset];
        adjustedAmount = collateralAmount;

        if (collateralSharesToBurn > userCollateralShares) {
            collateralSharesToBurn = userCollateralShares;
            adjustedAmount = _assetsFromShares(collateralSharesToBurn, supplyIndex);
        }
    }
}
