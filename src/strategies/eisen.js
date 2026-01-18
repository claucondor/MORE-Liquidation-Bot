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
      WFLOW
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
        tokenIn: collateralAsset,
        tokenOut: debtAsset,
        amountIn: expectedCollateral.toString(),
        receiver: contractAddress,
        slippage: 1,
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

      // Calculate expected output
      const expectedDebtOutput = swap1Result.quote?.expectedOutput
        ? BigInt(swap1Result.quote.expectedOutput)
        : expectedCollateral.mul(95).div(100); // Estimate 95% of collateral value

      // Calculate flash loan fee
      const flashLoanFee = debtToCover.mul(FEES.FLASH_LOAN_PREMIUM_BPS).div(10000n);
      const totalNeeded = debtToCover.add(flashLoanFee);

      // Calculate reward
      const rewardAmount = expectedDebtOutput > totalNeeded
        ? expectedDebtOutput - totalNeeded
        : 0n;

      // If debt is WFLOW, no need for second swap
      if (debtAsset.toLowerCase() === WFLOW.toLowerCase()) {
        sParamToSendToReceiver = {
          swapType: 0,
          router: '0x0000000000000000000000000000000000000000',
          path: '0x',
          amountIn: '0',
          amountOutMin: '0',
          adapters: []
        };
        estimatedReward = rewardAmount;
      } else {
        // Need second swap: debt → WFLOW
        const swap2Result = await buildSwapParams({
          tokenIn: debtAsset,
          tokenOut: WFLOW,
          amountIn: rewardAmount.toString(),
          receiver: receiver,
          slippage: 1,
          apiKey: eisenApiKey,
        });

        if (!swap2Result?.swapParams) {
          console.log('[Eisen] Failed to get swap2 params, using empty');
          sParamToSendToReceiver = {
            swapType: 0,
            router: '0x0000000000000000000000000000000000000000',
            path: '0x',
            amountIn: '0',
            amountOutMin: '0',
            adapters: []
          };
          estimatedReward = rewardAmount;
        } else {
          sParamToSendToReceiver = swap2Result.swapParams;
          sParamToSendToReceiver.amountIn = '0';
          sParamToSendToReceiver.amountOutMin = '0';
          quote2 = swap2Result.quote;
          estimatedReward = quote2?.expectedOutput
            ? BigInt(quote2.expectedOutput)
            : rewardAmount;
        }
      }

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
