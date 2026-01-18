/**
 * Helper utilities
 */
const { BigNumber } = require('ethers');
const { DECIMALS, STABLECOINS, TOKENS } = require('../constants');

/**
 * Shorten address for display
 */
function shortAddr(addr) {
  if (!addr) return 'null';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Format BigNumber with decimals
 */
function formatUnits(value, decimals = 18) {
  if (!value) return '0';
  const bn = BigNumber.from(value);
  const divisor = BigNumber.from(10).pow(decimals);
  const intPart = bn.div(divisor);
  const fracPart = bn.mod(divisor);

  // Pad fraction with leading zeros
  let fracStr = fracPart.toString().padStart(decimals, '0');
  // Trim trailing zeros but keep at least 2 decimals
  fracStr = fracStr.replace(/0+$/, '').padEnd(2, '0').slice(0, 6);

  return `${intPart.toString()}.${fracStr}`;
}

/**
 * Parse units to BigNumber
 */
function parseUnits(value, decimals = 18) {
  const [intPart, fracPart = ''] = value.toString().split('.');
  const paddedFrac = fracPart.padEnd(decimals, '0').slice(0, decimals);
  return BigNumber.from(intPart + paddedFrac);
}

/**
 * Check if token is a stablecoin
 */
function isStablecoin(token) {
  return STABLECOINS.has(token.toLowerCase());
}

/**
 * Check if swap is between stablecoins
 */
function isStableSwap(tokenA, tokenB) {
  return isStablecoin(tokenA) && isStablecoin(tokenB);
}

/**
 * Get token decimals
 */
function getDecimals(token) {
  return DECIMALS[token] || DECIMALS[token.toLowerCase()] || 18;
}

/**
 * Get token symbol from address
 */
function getTokenSymbol(address) {
  const addr = address.toLowerCase();
  for (const [symbol, tokenAddr] of Object.entries(TOKENS)) {
    if (tokenAddr.toLowerCase() === addr) {
      return symbol;
    }
  }
  return shortAddr(address);
}

/**
 * Calculate dynamic gas multiplier based on expected profit
 */
function calculateGasMultiplier(profitUsd) {
  if (profitUsd < 5) return 150;       // 1.5x base
  if (profitUsd < 50) return 250;      // 2.5x for medium
  if (profitUsd < 200) return 400;     // 4x for good opportunities
  if (profitUsd < 1000) return 500;    // 5x for big fish
  if (profitUsd < 5000) return 600;    // 6x for whales
  return 800;                           // 8x for mega positions
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      const delay = baseDelay * Math.pow(2, i);
      console.log(`[Retry] Attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

/**
 * Format USD value
 */
function formatUsd(value) {
  return `$${Number(value).toFixed(2)}`;
}

/**
 * Calculate percentage
 */
function bpsToPercent(bps) {
  return Number(bps) / 100;
}

/**
 * Apply slippage to amount
 */
function applySlippage(amount, slippageBps) {
  const bn = BigNumber.from(amount);
  return bn.mul(10000n - BigInt(slippageBps)).div(10000n);
}

/**
 * Calculate dynamic slippage based on position size
 * Larger positions need more slippage tolerance
 */
function calculateDynamicSlippage(debtValueUsd) {
  if (debtValueUsd < 100) return 0.02;      // 2% for small
  if (debtValueUsd < 1000) return 0.03;     // 3% for medium
  if (debtValueUsd < 10000) return 0.05;    // 5% for large
  if (debtValueUsd < 50000) return 0.07;    // 7% for very large
  return 0.10;                               // 10% for huge positions
}

/**
 * Find StableKitty pool for a token pair
 */
function findStableKittyPool(tokenA, tokenB) {
  const { STABLEKITTY_POOLS } = require('../constants');
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();

  for (const [name, pool] of Object.entries(STABLEKITTY_POOLS)) {
    const p0 = pool.token0.toLowerCase();
    const p1 = pool.token1.toLowerCase();

    if ((a === p0 && b === p1) || (a === p1 && b === p0)) {
      return {
        ...pool,
        name,
        inputIndex: a === p0 ? pool.token0Index : pool.token1Index,
        outputIndex: a === p0 ? pool.token1Index : pool.token0Index
      };
    }
  }
  return null;
}

module.exports = {
  shortAddr,
  formatUnits,
  parseUnits,
  isStablecoin,
  isStableSwap,
  getDecimals,
  getTokenSymbol,
  calculateGasMultiplier,
  calculateDynamicSlippage,
  findStableKittyPool,
  sleep,
  retry,
  formatUsd,
  bpsToPercent,
  applySlippage,
};
