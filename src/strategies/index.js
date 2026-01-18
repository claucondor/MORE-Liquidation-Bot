/**
 * Strategies module - exports all strategies and manager
 */
const BaseStrategy = require('./base');
const { executeStrategy, tryStrategiesInOrder, simulateStrategy } = require('./executor');
const { StableKittyMoreStrategy, StableKittyV3Strategy } = require('./stablekitty');
const { V2FlashSwapStrategy } = require('./v2-flash');
const { V3FlashStrategy } = require('./v3-flash');
const { V2DirectMoreStrategy, V3DirectStrategy } = require('./v2-direct');
const { EisenStrategy } = require('./eisen');

/**
 * Get all strategies in priority order
 * Lower priority number = tried first
 */
function getAllStrategies() {
  return [
    new StableKittyMoreStrategy(),   // 1. Best for stable↔stable
    new StableKittyV3Strategy(),     // 2. Alternative for stable↔stable
    new V2FlashSwapStrategy(),       // 3. V2 flash swap
    new V3FlashStrategy(),           // 4. V3 flash
    new V2DirectMoreStrategy(),      // 5. MORE flash + V2 swap
    new V3DirectStrategy(),          // 6. V3 flash + V2 swap
    new EisenStrategy(),             // 7. Fallback - always works
  ].sort((a, b) => a.priority - b.priority);
}

/**
 * Get strategies filtered by context
 * Returns only strategies that can handle the given liquidation
 */
function getApplicableStrategies(context) {
  return getAllStrategies().filter(s => s.canHandle(context));
}

/**
 * Strategy Manager - high-level interface for executing liquidations
 */
class StrategyManager {
  constructor(options = {}) {
    this.strategies = getAllStrategies();
    this.options = options;
  }

  /**
   * Execute a liquidation using the best available strategy
   */
  async execute(context, executionOptions) {
    const applicable = this.strategies.filter(s => s.canHandle(context));

    if (applicable.length === 0) {
      console.log('[StrategyManager] No applicable strategies found');
      return { success: false, error: 'No applicable strategies' };
    }

    console.log(`[StrategyManager] ${applicable.length} applicable strategies: ${applicable.map(s => s.name).join(', ')}`);

    return tryStrategiesInOrder(applicable, context, executionOptions);
  }

  /**
   * Get the best strategy for a liquidation without executing
   */
  async getBestStrategy(context) {
    const applicable = this.strategies.filter(s => s.canHandle(context));

    if (applicable.length === 0) {
      return null;
    }

    // Return highest priority (lowest number)
    return applicable[0];
  }

  /**
   * Simulate all applicable strategies
   */
  async simulateAll(context, executionOptions) {
    const results = [];

    for (const strategy of this.strategies) {
      if (!strategy.canHandle(context)) {
        continue;
      }

      try {
        const params = await strategy.buildParams(context);
        if (!params) {
          results.push({ strategy: strategy.name, success: false, error: 'Failed to build params' });
          continue;
        }

        const simResult = await simulateStrategy(strategy, params, executionOptions);
        results.push({
          strategy: strategy.name,
          success: simResult.success,
          error: simResult.error,
          estimatedReward: params.estimatedReward?.toString()
        });
      } catch (err) {
        results.push({ strategy: strategy.name, success: false, error: err.message });
      }
    }

    return results;
  }
}

module.exports = {
  BaseStrategy,
  StableKittyMoreStrategy,
  StableKittyV3Strategy,
  V2FlashSwapStrategy,
  V3FlashStrategy,
  V2DirectMoreStrategy,
  V3DirectStrategy,
  EisenStrategy,
  executeStrategy,
  tryStrategiesInOrder,
  simulateStrategy,
  getAllStrategies,
  getApplicableStrategies,
  StrategyManager,
};
