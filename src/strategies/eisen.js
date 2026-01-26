/**
 * Eisen Strategy - fallback using Eisen API for optimal routing
 */
const BaseStrategy = require('./base');
const { Strategy, STRATEGY_INFO, FEES, TOKENS } = require('../constants');
const {
  buildLiquidationParams,
} = require('../utils/encoding');

// Import the existing eisen module
const { buildSwapParams } = require('../../eisen.js');

/**
 * Eisen Flash Loan Strategy
 * Uses execute() with MORE flash loan, swaps via Eisen API
 * This is the fallback strategy that should always work
 */
class EisenStrategy extends BaseStrategy {
  constructor() {
    super(Strategy.EISEN_FLASH_LOAN, {
      fee: 50,     // ~0.5% estimated (varies by route)
      priority: 99 // Lowest priority - fallback
    });
  }

  getDisplayInfo() {
    return STRATEGY_INFO[Strategy.EISEN_FLASH_LOAN];
  }

  getContractMethod() {
    return 'execute';
  }

  /**
   * Can always handle if Eisen API key is available
   */
  canHandle(context) {
    const { eisenApiKey } = context;
    return !!eisenApiKey;
  }

  async buildParams(context) {
    const {
      collateralAsset,
      debtAsset,
      user,
      debtToCover,
      expectedCollateral,
      contractAddress,
      receiver,
      eisenApiKey,
      wflow: WFLOW
    } = context;

    // Build liquidation params
    const lParam = buildLiquidationParams(
      collateralAsset,
      debtAsset,
      user,
      debtToCover
    );

    try {
      // Get swap params from Eisen API for collateral → debt
      const swap1Result = await buildSwapParams({
        fromToken: collateralAsset,
        toToken: debtAsset,
        fromAmount: expectedCollateral.toString(),
        fromAddress: contractAddress,
        toAddress: contractAddress, // Output stays in contract to repay
        slippage: 0.05, // 5% slippage for safety
        apiKey: eisenApiKey,
      });

      if (!swap1Result?.swapParams) {
        console.log('[Eisen] Failed to get swap1 params');
        return null;
      }

      const sParamToRepayLoan = swap1Result.swapParams;
      let sParamToSendToReceiver;
      let quote2 = null;
      let estimatedReward;

      // Calculate expected output - convert to BigInt for consistency
      const expectedDebtOutput = swap1Result.quote?.expectedOutput
        ? BigInt(swap1Result.quote.expectedOutput)
        : BigInt(expectedCollateral.mul(95).div(100).toString()); // Estimate 95% of collateral value

      // Calculate flash loan fee - convert to BigInt
      const debtToCoverBigInt = BigInt(debtToCover.toString());
      const flashLoanFee = debtToCoverBigInt * FEES.FLASH_LOAN_PREMIUM_BPS / 10000n;
      const totalNeeded = debtToCoverBigInt + flashLoanFee;

      // Calculate reward (all BigInt now)
      const rewardAmount = expectedDebtOutput > totalNeeded
        ? expectedDebtOutput - totalNeeded
        : 0n;

      // SIMPLIFIED: Always receive reward in debt token directly
      // The second swap with Eisen fails because amountIn=0 on-chain
      // but Eisen routes are optimized for specific amounts
      // Solution: Skip second swap, receive reward in debt token (stables are fine)
      sParamToSendToReceiver = {
        swapType: 0,
        router: '0x0000000000000000000000000000000000000000',
        path: '0x',
        amountIn: '0',
        amountOutMin: '0',
        adapters: []
      };
      estimatedReward = rewardAmount;
      console.log(`[Eisen] Reward will be received in debt token (${rewardAmount.toString()})`);

      return {
        lParam,
        sParamToRepayLoan,
        sParamToSendToReceiver,
        receiver,
        estimatedReward,
        quote2
      };

    } catch (err) {
      console.log(`[Eisen] Error building params: ${err.message?.slice(0, 80)}`);
      return null;
    }
  }
}

module.exports = {
  EisenStrategy,
};
