/**
 * Pricing service - handles oracle prices and quotes
 */
const { Contract, BigNumber } = require('ethers');
const { ABIS, STABLEKITTY_POOLS } = require('../constants');

class PricingService {
  constructor(oracleContract, provider) {
    this.oracle = oracleContract;
    this.provider = provider;
    this.priceCache = new Map();
    this.cacheTtl = 10000; // 10 seconds
  }

  /**
   * Get asset price from oracle (8 decimals)
   */
  async getPrice(asset) {
    const cacheKey = asset.toLowerCase();
    const cached = this.priceCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.cacheTtl) {
      return cached.price;
    }

    try {
      const price = await this.oracle.getAssetPrice(asset);
      this.priceCache.set(cacheKey, { price, timestamp: Date.now() });
      return price;
    } catch (err) {
      console.error(`[Pricing] Error getting price for ${asset}: ${err.message}`);
      return cached?.price || BigNumber.from(0);
    }
  }

  /**
   * Get prices for multiple assets
   */
  async getPrices(assets) {
    const prices = {};
    await Promise.all(
      assets.map(async (asset) => {
        prices[asset] = await this.getPrice(asset);
      })
    );
    return prices;
  }

  /**
   * Convert amount to USD value
   */
  async getUsdValue(asset, amount, decimals = 18) {
    const price = await this.getPrice(asset);
    // price is 8 decimals, amount is `decimals` decimals
    // result should be in USD (2 decimals for display)
    const value = BigNumber.from(amount)
      .mul(price)
      .div(BigNumber.from(10).pow(decimals));
    return Number(value.toString()) / 1e8;
  }

  /**
   * Get quote from StableKitty pool
   */
  async getStableKittyQuote(poolName, amountIn, inputIndex, outputIndex) {
    const pool = STABLEKITTY_POOLS[poolName];
    if (!pool) return null;

    try {
      const contract = new Contract(pool.address, ABIS.STABLEKITTY, this.provider);
      const amountOut = await contract.get_dy(inputIndex, outputIndex, amountIn);
      return BigNumber.from(amountOut);
    } catch (err) {
      console.log(`[Pricing] StableKitty quote error: ${err.message?.slice(0, 50)}`);
      return null;
    }
  }

  /**
   * Clear price cache
   */
  clearCache() {
    this.priceCache.clear();
  }

  /**
   * Pre-warm cache for common tokens
   */
  async warmCache(tokens) {
    console.log('[Pricing] Warming cache...');
    await this.getPrices(tokens);
  }
}

module.exports = PricingService;
