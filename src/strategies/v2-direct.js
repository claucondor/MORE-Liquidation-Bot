/**
 * V2 Direct Strategy - MORE flash loan + V2 swap (no API)
 */
const { BigNumber } = require('ethers');
const BaseStrategy = require('./base');
const { Strategy, STRATEGY_INFO, FEES } = require('../constants');
const {
  buildV2SwapParams,
  buildEmptySwapParams,
  buildLiquidationParams,
} = require('../utils/encoding');
const { applySlippage, isStableSwap } = require('../utils/helpers');

/**
 * V2 Direct + MORE Flash Loan Strategy
 * Uses execute() with MORE flash loan, swaps via V2 router without API
 */
class V2DirectMoreStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.V2_DIRECT_MORE, {
      fee: 35,     // 0.05% flash + 0.3% V2 swap
      priority: 5
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.V2_DIRECT_MORE];
  }

  getContractMethod() {
    return 'execute';
  }

  /**
   * Can handle most liquidations if there's a V2 path
   * Skip stable↔stable (use StableKitty instead)
   */
  canHandle(context) {
    const { collateralAsset, debtAsset, punchswapRouter } = context;

    // StableKitty is better for stable↔stable
    if (isStableSwap(collateralAsset, debtAsset)) {
      return false;
    }

    // Need a router
    if (!punchswapRouter) {
      return false;
    }

    return true;
  }

  async buildParams(context) {
    const {
      collateralAsset,
      debtAsset,
      user,
      debtToCover,
      expectedCollateral,
      punchswapRouter,
      contractAddress,
      receiver
    } = context;

    // Calculate flash loan fee (0.05%)
    const flashLoanFee = debtToCover.mul(FEES.FLASH_LOAN_PREMIUM_BPS).div(10000n);
    const totalNeeded = debtToCover.add(flashLoanFee);

    // Estimate reward (~5% liquidation bonus)
    const estimatedReward = expectedCollateral.mul(5).div(100);

    // Build params
    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    // Swap collateral → debt via V2 router
    const minOutput = applySlippage(totalNeeded, 100n); // 1% slippage
    const sParamToRepayLoan = buildV2SwapParams(
      collateralAsset,
      debtAsset,
      expectedCollateral,
      minOutput,
      punchswapRouter
    );

    // Empty second swap - receive reward in debt token
    const sParamToSendToReceiver = buildEmptySwapParams();

    return {
      lParam,
      sParamToRepayLoan,
      sParamToSendToReceiver,
      receiver,
      estimatedReward
    };
  }
}

/**
 * V3 Direct Strategy
 * Uses executeFlashV3() with V3 pool, swaps via V2 router without API
 */
class V3DirectStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.V3_DIRECT, {
      fee: 31,     // ~0.01-0.3% flash + 0.3% V2 swap
      priority: 6
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.V3_DIRECT];
  }

  getContractMethod() {
    return 'executeFlashV3';
  }

  canHandle(context) {
    const { collateralAsset, debtAsset, v3Pool, punchswapRouter } = context;

    if (isStableSwap(collateralAsset, debtAsset)) {
      return false;
    }

    if (!v3Pool || !punchswapRouter) {
      return false;
    }

    return true;
  }

  async buildParams(context) {
    const {
      collateralAsset,
      debtAsset,
      user,
      debtToCover,
      expectedCollateral,
      v3Pool,
      v3Fee,
      punchswapRouter,
      contractAddress,
      receiver
    } = context;

    // Calculate V3 flash fee
    const feeBps = v3Fee || 3000;
    const flashFee = debtToCover.mul(feeBps).div(1000000n);
    const totalNeeded = debtToCover.add(flashFee);

    const estimatedReward = expectedCollateral.mul(5).div(100);

    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    const minOutput = applySlippage(totalNeeded, 100n);
    const sParamToRepayLoan = buildV2SwapParams(
      collateralAsset,
      debtAsset,
      expectedCollateral,
      minOutput,
      punchswapRouter
    );

    const sParamToSendToReceiver = buildEmptySwapParams();

    return {
      lParam,
      sParamToRepayLoan,
      sParamToSendToReceiver,
      v3Pool,
      receiver,
      estimatedReward
    };
  }
}

module.exports = {
  V2DirectMoreStrategy,
  V3DirectStrategy,
};
