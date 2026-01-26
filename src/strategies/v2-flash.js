/**
 * V2 Flash Swap Strategy - uses PunchSwap V2 flash swap
 */
const { BigNumber } = require('ethers');
const BaseStrategy = require('./base');
const { Strategy, STRATEGY_INFO, FEES } = require('../constants');
const {
  buildV2SwapParams,
  buildEmptySwapParams,
  buildLiquidationParams,
} = require('../utils/encoding');
const { applySlippage } = require('../utils/helpers');

/**
 * V2 Flash Swap Strategy
 * Uses executeFlashSwap() - borrows from V2 pair, swaps collateral back via V2
 */
class V2FlashSwapStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.V2_FLASH_SWAP, {
      fee: 30,     // 0.3% V2 flash swap fee
      priority: 3
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.V2_FLASH_SWAP];
  }

  getContractMethod() {
    return 'executeFlashSwap';
  }

  /**
   * Can handle if there's a whitelisted V2 pair for the debt token
   */
  canHandle(context) {
    const { v2Pool, v2PoolLiquidity } = context;

    if (!v2Pool) {
      return false;
    }

    // Check minimum liquidity
    if (v2PoolLiquidity && v2PoolLiquidity.lt(context.debtToCover.mul(2))) {
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
      v2Pool,
      punchswapRouter,
      contractAddress,
      receiver,
      slippageBps = 300n // Default 3%
    } = context;

    // Calculate flash swap fee (0.3%)
    const flashSwapFee = debtToCover.mul(FEES.FLASH_SWAP_FEE_BPS).div(10000n);
    const totalNeeded = debtToCover.add(flashSwapFee);

    // Estimate reward with slippage consideration
    const slippageFactor = 10000n - BigInt(slippageBps);
    const estimatedReward = expectedCollateral.mul(5).div(100).mul(slippageFactor).div(10000n);

    // Build params
    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    // Swap collateral → debt via V2 router with DYNAMIC slippage
    const minOutput = applySlippage(totalNeeded, slippageBps);
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
      v2Pool,
      receiver,
      estimatedReward
    };
  }
}

module.exports = {
  V2FlashSwapStrategy,
};
