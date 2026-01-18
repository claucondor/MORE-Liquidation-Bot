/**
 * V3 Flash Strategy - uses UniswapV3 style flash loan
 */
const { BigNumber } = require('ethers');
const BaseStrategy = require('./base');
const { Strategy, STRATEGY_INFO } = require('../constants');
const {
  buildV2SwapParams,
  buildEmptySwapParams,
  buildLiquidationParams,
} = require('../utils/encoding');
const { applySlippage } = require('../utils/helpers');

/**
 * V3 Flash Strategy
 * Uses executeFlashV3() - borrows from V3 pool, swaps collateral via V2 router
 */
class V3FlashStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.V3_FLASH, {
      fee: 30,     // Variable 0.01%-0.3% depending on pool
      priority: 4
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.V3_FLASH];
  }

  getContractMethod() {
    return 'executeFlashV3';
  }

  /**
   * Can handle if there's a whitelisted V3 pool for the debt token
   */
  canHandle(context) {
    const { v3Pool, v3PoolLiquidity } = context;

    if (!v3Pool) {
      return false;
    }

    // Check minimum liquidity
    if (v3PoolLiquidity && v3PoolLiquidity.lt(context.debtToCover.mul(2))) {
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
    const feeBps = v3Fee || 3000; // Default to 0.3% (3000 = 0.3% in V3 terms)
    const flashFee = debtToCover.mul(feeBps).div(1000000n);
    const totalNeeded = debtToCover.add(flashFee);

    // Estimate reward
    const estimatedReward = expectedCollateral.mul(5).div(100); // ~5% bonus estimate

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
      v3Pool,
      receiver,
      estimatedReward
    };
  }
}

module.exports = {
  V3FlashStrategy,
};
