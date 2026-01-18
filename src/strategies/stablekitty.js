/**
 * StableKitty Strategy - for stable↔stable liquidations
 * Uses Curve-style pools with very low slippage
 */
const { Contract, BigNumber } = require('ethers');
const BaseStrategy = require('./base');
const {
  STABLEKITTY_POOLS,
  ABIS,
  FEES,
  Strategy,
  STRATEGY_INFO
} = require('../constants');
const {
  buildStableKittySwapParams,
  buildEmptySwapParams,
  buildLiquidationParams,
  findStableKittyPool,
} = require('../utils/encoding');
const { isStableSwap, applySlippage } = require('../utils/helpers');

/**
 * StableKitty + MORE Flash Loan Strategy
 */
class StableKittyMoreStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.STABLEKITTY_MORE, {
      fee: 6,      // ~0.06% total (0.05% flash + 0.01% stablekitty)
      priority: 1  // Highest priority for stable↔stable
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.STABLEKITTY_MORE];
  }

  getContractMethod() {
    return 'execute';  // Uses MORE/Aave flash loan
  }

  /**
   * Can handle if both collateral and debt are stablecoins
   * and there's a StableKitty pool for them
   */
  canHandle(context) {
    const { collateralAsset, debtAsset } = context;

    if (!isStableSwap(collateralAsset, debtAsset)) {
      return false;
    }

    const pool = findStableKittyPool(collateralAsset, debtAsset);
    return pool !== null;
  }

  async buildParams(context) {
    const {
      collateralAsset,
      debtAsset,
      user,
      debtToCover,
      expectedCollateral,
      provider,
      contractAddress,
      receiver
    } = context;

    // Find the StableKitty pool
    const pool = findStableKittyPool(collateralAsset, debtAsset);
    if (!pool) {
      console.log('[StableKitty] No pool found');
      return null;
    }

    // Get quote from StableKitty
    const stableContract = new Contract(pool.address, ABIS.STABLEKITTY, provider);

    let stableQuote;
    try {
      stableQuote = await stableContract.get_dy(
        pool.inputIndex,
        pool.outputIndex,
        expectedCollateral
      );
    } catch (err) {
      console.log(`[StableKitty] Quote error: ${err.message?.slice(0, 50)}`);
      return null;
    }

    // Calculate total needed (debt + flash loan fee)
    const flashLoanFee = debtToCover.mul(FEES.FLASH_LOAN_PREMIUM_BPS).div(10000n);
    const totalNeeded = debtToCover.add(flashLoanFee);

    // Check profitability
    if (stableQuote.lte(totalNeeded)) {
      console.log(`[StableKitty] Not profitable: ${stableQuote.toString()} <= ${totalNeeded.toString()}`);
      return null;
    }

    const estimatedReward = stableQuote.sub(totalNeeded);
    console.log(`[StableKitty] Estimated reward: ${estimatedReward.toString()}`);

    // Apply slippage
    const minOutput = applySlippage(totalNeeded, FEES.STABLEKITTY_SLIPPAGE_BPS);

    // Build params
    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    const sParamToRepayLoan = buildStableKittySwapParams(
      pool,
      expectedCollateral,
      minOutput,
      contractAddress
    );

    // Empty second swap - receive reward in debt token directly
    const sParamToSendToReceiver = buildEmptySwapParams();

    return {
      lParam,
      sParamToRepayLoan,
      sParamToSendToReceiver,
      receiver,
      estimatedReward,
      pool
    };
  }
}

/**
 * StableKitty + V3 Flash Strategy
 */
class StableKittyV3Strategy extends BaseStrategy {
  constructor() {
    super(Strategy.STABLEKITTY_V3, {
      fee: 2,      // ~0.02% total (0.01% v3 flash + 0.01% stablekitty)
      priority: 2  // Second priority for stable↔stable
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.STABLEKITTY_V3];
  }

  getContractMethod() {
    return 'executeFlashV3';
  }

  canHandle(context) {
    const { collateralAsset, debtAsset, v3Pool } = context;

    if (!isStableSwap(collateralAsset, debtAsset)) {
      return false;
    }

    const pool = findStableKittyPool(collateralAsset, debtAsset);
    return pool !== null && v3Pool !== null;
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
      provider,
      contractAddress,
      receiver
    } = context;

    // Find the StableKitty pool
    const stablePool = findStableKittyPool(collateralAsset, debtAsset);
    if (!stablePool) {
      return null;
    }

    // Get quote from StableKitty
    const stableContract = new Contract(stablePool.address, ABIS.STABLEKITTY, provider);

    let stableQuote;
    try {
      stableQuote = await stableContract.get_dy(
        stablePool.inputIndex,
        stablePool.outputIndex,
        expectedCollateral
      );
    } catch (err) {
      console.log(`[StableKitty+V3] Quote error: ${err.message?.slice(0, 50)}`);
      return null;
    }

    // Calculate total needed (debt + V3 flash fee)
    const v3FeeBps = v3Fee || 30; // Default to 0.3%
    const flashFee = debtToCover.mul(v3FeeBps).div(1000000n); // V3 fee is in 1e6
    const totalNeeded = debtToCover.add(flashFee);

    if (stableQuote.lte(totalNeeded)) {
      console.log(`[StableKitty+V3] Not profitable`);
      return null;
    }

    const estimatedReward = stableQuote.sub(totalNeeded);
    const minOutput = applySlippage(totalNeeded, FEES.STABLEKITTY_SLIPPAGE_BPS);

    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    const sParamToRepayLoan = buildStableKittySwapParams(
      stablePool,
      expectedCollateral,
      minOutput,
      contractAddress
    );

    const sParamToSendToReceiver = buildEmptySwapParams();

    return {
      lParam,
      sParamToRepayLoan,
      sParamToSendToReceiver,
      v3Pool,
      receiver,
      estimatedReward,
      pool: stablePool
    };
  }
}

module.exports = {
  StableKittyMoreStrategy,
  StableKittyV3Strategy,
};
