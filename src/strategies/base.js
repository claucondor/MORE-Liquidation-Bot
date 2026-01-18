/**
 * Base Strategy class - all strategies extend this
 */
const { BigNumber } = require('ethers');

/**
 * Base class for liquidation strategies
 * Each strategy must implement:
 * - canHandle(context): boolean - can this strategy handle this liquidation?
 * - buildParams(context): { lParam, sParamToRepayLoan, sParamToSendToReceiver, extraArgs }
 * - getContractMethod(): 'execute' | 'executeFlashSwap' | 'executeFlashV3'
 */
class BaseStrategy {
  constructor(name, config = {}) {
    this.name = name;
    this.fee = config.fee || 0;       // Fee in basis points
    this.priority = config.priority || 100;  // Lower = higher priority
  }

  /**
   * Check if this strategy can handle the given liquidation context
   * @param {Object} context - { collateral, debt, user, pools, prices, config }
   * @returns {boolean}
   */
  canHandle(context) {
    throw new Error('canHandle() must be implemented by subclass');
  }

  /**
   * Build the parameters needed for this strategy
   * @param {Object} context - liquidation context
   * @returns {Object} { lParam, sParamToRepayLoan, sParamToSendToReceiver, extraArgs, estimatedReward }
   */
  async buildParams(context) {
    throw new Error('buildParams() must be implemented by subclass');
  }

  /**
   * Get the contract method name to call
   * @returns {string} 'execute' | 'executeFlashSwap' | 'executeFlashV3'
   */
  getContractMethod() {
    throw new Error('getContractMethod() must be implemented by subclass');
  }

  /**
   * Get method arguments in order for the contract call
   * @param {Object} params - output from buildParams()
   * @returns {Array} arguments for contract call
   */
  getMethodArgs(params) {
    const method = this.getContractMethod();

    switch (method) {
      case 'execute':
        return [
          params.lParam,
          params.sParamToRepayLoan,
          params.sParamToSendToReceiver,
          params.receiver
        ];

      case 'executeFlashSwap':
        return [
          params.v2Pool,
          params.lParam,
          params.sParamToRepayLoan,
          params.sParamToSendToReceiver,
          params.receiver
        ];

      case 'executeFlashV3':
        return [
          params.v3Pool,
          params.lParam,
          params.sParamToRepayLoan,
          params.sParamToSendToReceiver,
          params.receiver
        ];

      default:
        throw new Error(`Unknown contract method: ${method}`);
    }
  }

  /**
   * Get estimated fee in basis points
   * @returns {number}
   */
  getFeeBps() {
    return this.fee;
  }

  /**
   * Get display info for this strategy
   * @returns {{ name: string, emoji: string }}
   */
  getDisplayInfo() {
    return {
      name: this.name,
      emoji: '📊'
    };
  }

  /**
   * Estimate profit for this strategy
   * @param {Object} context - liquidation context
   * @param {BigNumber} debtToCover - amount of debt to liquidate
   * @returns {BigNumber} estimated profit in debt token
   */
  async estimateProfit(context, debtToCover) {
    // Default implementation: liquidation bonus - fees
    const bonus = debtToCover.mul(5).div(100); // 5% liquidation bonus
    const fees = debtToCover.mul(this.fee).div(10000);
    return bonus.sub(fees);
  }
}

module.exports = BaseStrategy;
