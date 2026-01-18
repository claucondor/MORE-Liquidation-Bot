/**
 * Strategy Executor - common execution logic for all strategies
 */
const { BigNumber } = require('ethers');
const { calculateGasMultiplier, shortAddr } = require('../utils/helpers');

/**
 * Execute a liquidation using the given strategy
 * @param {BaseStrategy} strategy - strategy instance
 * @param {Object} params - output from strategy.buildParams()
 * @param {Object} options - { contract, wallet, gasPrice, profitUsd }
 * @returns {Object} { success, txHash, receipt, error }
 */
async function executeStrategy(strategy, params, options) {
  const { contract, wallet, provider, profitUsd = 10 } = options;

  const methodName = strategy.getContractMethod();
  const args = strategy.getMethodArgs(params);

  console.log(`[${strategy.name}] Simulating...`);

  try {
    // 1. Simulate first with callStatic
    await contract.callStatic[methodName](...args, {
      from: wallet.address
    });
    console.log(`[${strategy.name}] Simulation OK`);

    // 2. Get gas price with dynamic multiplier
    const gasPrice = await provider.getGasPrice();
    const gasMultiplier = calculateGasMultiplier(profitUsd);
    const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

    console.log(`[${strategy.name}] Sending tx (gas: ${gasMultiplier / 100}x)...`);

    // 3. Execute
    const tx = await contract.connect(wallet)[methodName](...args, {
      gasLimit: 4000000,
      gasPrice: adjustedGasPrice
    });

    console.log(`[${strategy.name}] Tx sent: ${tx.hash}`);

    // 4. Wait for receipt
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log(`[${strategy.name}] SUCCESS!`);
      return {
        success: true,
        txHash: tx.hash,
        receipt,
        strategy: strategy.name,
        gasUsed: receipt.gasUsed.toString(),
        error: null
      };
    } else {
      console.log(`[${strategy.name}] FAILED (reverted)`);
      return {
        success: false,
        txHash: tx.hash,
        receipt,
        strategy: strategy.name,
        error: 'Transaction reverted'
      };
    }

  } catch (err) {
    const reason = err?.error?.reason || err?.reason || err?.message || 'Unknown error';
    console.log(`[${strategy.name}] Failed: ${reason.slice(0, 80)}`);

    return {
      success: false,
      txHash: null,
      receipt: null,
      strategy: strategy.name,
      error: reason
    };
  }
}

/**
 * Try multiple strategies in order until one succeeds
 * @param {Array<BaseStrategy>} strategies - ordered list of strategies
 * @param {Object} context - liquidation context
 * @param {Object} options - execution options
 * @returns {Object} { success, result, usedStrategy }
 */
async function tryStrategiesInOrder(strategies, context, options) {
  const errors = [];

  for (const strategy of strategies) {
    // Check if strategy can handle this liquidation
    if (!strategy.canHandle(context)) {
      console.log(`[${strategy.name}] Cannot handle this liquidation, skipping`);
      continue;
    }

    try {
      // Build params for this strategy
      console.log(`[${strategy.name}] Building params...`);
      const params = await strategy.buildParams(context);

      if (!params) {
        console.log(`[${strategy.name}] Failed to build params, skipping`);
        continue;
      }

      // Execute
      const result = await executeStrategy(strategy, params, options);

      if (result.success) {
        return {
          success: true,
          result,
          usedStrategy: strategy.name,
          estimatedReward: params.estimatedReward
        };
      }

      errors.push({ strategy: strategy.name, error: result.error });

    } catch (err) {
      console.log(`[${strategy.name}] Error: ${err.message?.slice(0, 80)}`);
      errors.push({ strategy: strategy.name, error: err.message });
    }
  }

  return {
    success: false,
    result: null,
    usedStrategy: null,
    errors
  };
}

/**
 * Simulate a strategy without executing
 * Useful for checking if a strategy would work
 */
async function simulateStrategy(strategy, params, options) {
  const { contract, wallet } = options;

  const methodName = strategy.getContractMethod();
  const args = strategy.getMethodArgs(params);

  try {
    await contract.callStatic[methodName](...args, {
      from: wallet.address
    });
    return { success: true, error: null };
  } catch (err) {
    const reason = err?.error?.reason || err?.reason || err?.message || 'Unknown';
    return { success: false, error: reason };
  }
}

module.exports = {
  executeStrategy,
  tryStrategiesInOrder,
  simulateStrategy,
};
