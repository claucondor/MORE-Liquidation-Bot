const { Telegraf } = require('telegraf');
const { HttpLink } = require("apollo-link-http");
const { ApolloClient } = require("apollo-client");
const { InMemoryCache } = require("apollo-cache-inmemory");
const {
  utils,
  constants,
  providers,
  BigNumber,
  Wallet,
  Contract,
} = require("ethers");
const fs = require("fs");
const path = require("path");

const { usersQuery } = require("./query.js");
const { buildSwapParams, buildEmptySwapParams } = require("./eisen.js");
const { buildFlashSwapLiquidationParams, checkPairLiquidity, PAIR_ABI } = require("./punchswap.js");
const {
  Strategy,
  selectBestStrategy,
  calculateOptimalLiquidationAmount,
  calculateDynamicSlippage,
  getLiquiditySummary,
  getV2PairLiquidity,
  batchGetSwapQuotes,
  POOLS_CONFIG,
  TOKENS
} = require("./liquidity.js");

const config = require("./config.json");
const STATE_FILE = path.join(__dirname, "bot_state.json");
const PoolAbi = require("./abis/Pool.json");
const MTokenAbi = require("./abis/MToken.json");
const MulticallAbi = require("./abis/MulticallAbi.json");
const LiquidationAbi = require("./abis/Liquidation.json");
const AaveOracleAbi = require("./abis/AaveOracle.json");
const DataProviderAbi = require("./abis/DataProvider.json");

// ============================================
// DUAL RPC SYSTEM
// - publicProvider: lecturas (gratis, Flow público)
// - txProvider: transacciones (Alchemy, más confiable)
// ============================================
const PUBLIC_RPC = 'https://mainnet.evm.nodes.onflow.org';
const TX_RPC = config.rpc_url; // Alchemy

let provider = new providers.JsonRpcProvider(PUBLIC_RPC); // Lecturas
const txProvider = new providers.JsonRpcProvider(TX_RPC); // Solo para TX

let usingAlchemyFallback = false;

/**
 * Switch read provider to Alchemy (fallback if public fails)
 */
function switchToAlchemyFallback() {
  if (usingAlchemyFallback) return;
  console.log(`[RPC] Switching reads to Alchemy (fallback)...`);
  provider = new providers.JsonRpcProvider(TX_RPC);
  reinitializeContracts();
  usingAlchemyFallback = true;
}

/**
 * Switch back to public RPC for reads
 */
function switchToPublicRpc() {
  if (!usingAlchemyFallback) return;
  console.log(`[RPC] Switching reads back to public RPC...`);
  provider = new providers.JsonRpcProvider(PUBLIC_RPC);
  reinitializeContracts();
  usingAlchemyFallback = false;
}

/**
 * Get current read RPC URL
 */
function getCurrentRpc() {
  return usingAlchemyFallback ? TX_RPC : PUBLIC_RPC;
}

// Interfaces
const poolInterface = new utils.Interface(PoolAbi);
const mTokenInterface = new utils.Interface(MTokenAbi);

// Contracts (will be reinitialized on RPC switch)
let multicallContract = new Contract(
  config.contracts.multicall,
  MulticallAbi,
  provider
);

let oracleContract = new Contract(
  config.contracts.oracle,
  AaveOracleAbi,
  provider
);

let dataProviderContract = new Contract(
  config.contracts.dataProvider,
  DataProviderAbi,
  provider
);

/**
 * Reinitialize contracts after RPC switch
 */
function reinitializeContracts() {
  multicallContract = new Contract(config.contracts.multicall, MulticallAbi, provider);
  oracleContract = new Contract(config.contracts.oracle, AaveOracleAbi, provider);
  dataProviderContract = new Contract(config.contracts.dataProvider, DataProviderAbi, provider);
  console.log('[RPC] Contracts reinitialized');
}

// Constants
const WFLOW = config.contracts.wflow;
const CONSERVATIVE_FACTOR = 99n; // 99% of theoretical collateral (97% was too conservative for large positions)
const FLASH_LOAN_PREMIUM_BPS = 5n; // 0.05% = 5 bps
const FLASH_SWAP_FEE_BPS = 30n; // 0.3% = 30 bps (UniswapV2 fee)
const FLOWSCAN_URL = 'https://evm.flowscan.io';
const MIN_DEBT_USD = config.min_debt_usd || 1;

/**
 * Calculate dynamic gas multiplier based on expected profit
 * Bigger positions = more profit = willing to pay more gas
 * @param {number} profitUsd - Expected profit in USD
 * @returns {number} Gas multiplier (150 = 1.5x, 200 = 2x, etc.)
 */
function calculateGasMultiplier(profitUsd) {
  // Liquidation bonus is ~5%, so profit ~ 5% of debt
  // Aggressive gas to win against competitors
  //
  // Profit tiers:
  // < $5:      1.5x (small, don't overpay)
  // $5-$50:    2.5x (worth competing)
  // $50-$200:  4.0x (good opportunity)
  // $200-$1k:  5.0x (big fish)
  // $1k-$5k:   6.0x (whale)
  // $5k+:      8.0x (mega whale, MAX aggression)

  if (profitUsd < 5) return 150;       // 1.5x base
  if (profitUsd < 50) return 250;      // 2.5x for medium
  if (profitUsd < 200) return 400;     // 4x for good opportunities
  if (profitUsd < 1000) return 500;    // 5x for big fish
  if (profitUsd < 5000) return 600;    // 6x for whales
  return 800;                           // 8x for mega positions
}

// PunchSwap configuration
const PUNCHSWAP_ROUTER = config.contracts.punchswap?.router;
const FLASH_SWAP_PAIRS = config.contracts.flashSwapPairs || {};

// ============================================
// STABLEKITTY POOLS (Curve-style, low slippage for stables)
// ============================================
const STABLEKITTY_POOLS = {
  'PYUSD0_stgUSDC': {
    address: '0x0e9712Ad7dbC3c0AC25765f57E8805C3fd3cF717',
    token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
    token1: '0xF1815bd50389c46847f0Bda824eC8da914045D14', // stgUSDC
    token0Index: 0,
    token1Index: 1
  },
  'USDF_PYUSD0': {
    address: '0x6ddDFa511A940cA3fD5Ec7F6a4f23947cA30f030',
    token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
    token1: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
    token0Index: 0,
    token1Index: 1
  },
  'USDF_stgUSDC': {
    address: '0x20ca5d1C8623ba6AC8f02E41cCAFFe7bb6C92B57',
    token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
    token1: '0xF1815bd50389c46847f0Bda824eC8da914045D14', // stgUSDC
    token0Index: 0,
    token1Index: 1
  }
};

// Stablecoins (for detecting stable↔stable swaps)
const STABLECOINS = new Set([
  '0x99af3eea856556646c98c8b9b2548fe815240750', // PYUSD0
  '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
  '0x2aabea2058b5ac2d339b163c6ab6f2b6d53aabed', // USDF
]);

// StableKitty ABI (Curve-style)
const STABLEKITTY_ABI = [
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)',
  'function balances(uint256 i) view returns (uint256)'
];

const STABLEKITTY_SLIPPAGE_BPS = 50n; // 0.5% max slippage for StableKitty

/**
 * Check if swap is between stablecoins
 */
function isStableSwap(tokenA, tokenB) {
  return STABLECOINS.has(tokenA.toLowerCase()) && STABLECOINS.has(tokenB.toLowerCase());
}

/**
 * Find StableKitty pool for a token pair
 */
function findStableKittyPool(tokenA, tokenB) {
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
        outputIndex: a === p0 ? pool.token1Index : pool.token0Index,
      };
    }
  }
  return null;
}

/**
 * Get quote from StableKitty pool
 */
async function getStableKittyQuote(pool, amountIn) {
  try {
    const contract = new Contract(pool.address, STABLEKITTY_ABI, provider);
    const amountOut = await contract.get_dy(pool.inputIndex, pool.outputIndex, amountIn);
    return BigNumber.from(amountOut);
  } catch (err) {
    console.log(`[StableKitty] Quote error: ${err.message?.slice(0, 50)}`);
    return null;
  }
}

/**
 * Build swap params for StableKitty (uses swapType 3 with local calldata)
 */
function buildStableKittySwapParams(pool, amountIn, minAmountOut, receiver) {
  const iface = new utils.Interface(STABLEKITTY_ABI);
  const calldata = iface.encodeFunctionData('exchange', [
    pool.inputIndex,
    pool.outputIndex,
    amountIn,
    minAmountOut,
    receiver
  ]);

  const abiCoder = new utils.AbiCoder();
  const path = abiCoder.encode(
    ['address', 'address', 'bytes'],
    [pool.token0, pool.token1, calldata]
  );

  return {
    swapType: 3, // ApiAggregator - works with any calldata
    router: pool.address,
    path: path,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build V2 swap params directly (without Eisen API)
 */
function buildV2SwapParamsLocal(fromToken, toToken, amountIn, minAmountOut, router) {
  const path = [fromToken, toToken];
  const encodedPath = utils.defaultAbiCoder.encode(['address[]'], [path]);

  return {
    swapType: 0, // V2
    router: router,
    path: encodedPath,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build empty swap params
 */
function buildEmptySwapParamsLocal() {
  return {
    swapType: 0,
    router: constants.AddressZero,
    path: '0x',
    amountIn: '0',
    amountOutMin: '0',
    adapters: []
  };
}

/**
 * Check if Flash Swap is available for a given debt token
 * @param {string} debtToken - The debt token address
 * @returns {string|null} The pair address if available, null otherwise
 */
function getFlashSwapPair(debtToken) {
  const pair = FLASH_SWAP_PAIRS[debtToken.toLowerCase()] || FLASH_SWAP_PAIRS[debtToken];
  return pair || null;
}

/**
 * Get PunchSwap liquidity for all configured pairs
 * @returns {Promise<Object>} Liquidity info for each pair
 */
async function getPunchSwapLiquidity() {
  const pairs = config.contracts.punchswap?.pairs || {};
  const liquidity = {};

  for (const [name, pairAddress] of Object.entries(pairs)) {
    try {
      const pairContract = new Contract(pairAddress, PAIR_ABI, provider);
      const [token0, token1, reserves] = await Promise.all([
        pairContract.token0(),
        pairContract.token1(),
        pairContract.getReserves()
      ]);

      const reserve0 = BigNumber.from(reserves.reserve0);
      const reserve1 = BigNumber.from(reserves.reserve1);

      // Get prices to calculate USD value (handle oracle errors gracefully)
      let price0, price1;
      try { price0 = await getCachedPrice(token0); } catch { price0 = BigNumber.from(0); }
      try { price1 = await getCachedPrice(token1); } catch { price1 = BigNumber.from(0); }

      // Calculate TVL (both sides)
      // Prices are 8 decimals, reserves are 18 decimals (for WFLOW) or 6 (for USDF)
      const isToken0Stable = token0.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();
      const isToken1Stable = token1.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();

      // Get decimals for accurate TVL calculation
      const tok0Contract = new Contract(token0, ERC20_DECIMALS_ABI, provider);
      const tok1Contract = new Contract(token1, ERC20_DECIMALS_ABI, provider);
      const [dec0, dec1] = await Promise.all([
        tok0Contract.decimals().catch(() => 18),
        tok1Contract.decimals().catch(() => 18)
      ]);

      let tvlUsd;
      if (isToken0Stable) {
        // Token0 is USDF (6 decimals), double it for TVL
        tvlUsd = Number(reserve0.toString()) / Math.pow(10, dec0) * 2;
      } else if (isToken1Stable) {
        // Token1 is USDF (6 decimals), double it for TVL
        tvlUsd = Number(reserve1.toString()) / Math.pow(10, dec1) * 2;
      } else {
        // Both non-stable, use actual decimals and prices
        const value0 = Number(reserve0.toString()) / Math.pow(10, dec0) * Number(price0.toString()) / 1e8;
        const value1 = Number(reserve1.toString()) / Math.pow(10, dec1) * Number(price1.toString()) / 1e8;
        tvlUsd = value0 + value1; // Sum both sides instead of doubling one
      }

      liquidity[name] = {
        pair: pairAddress,
        reserve0: reserve0.toString(),
        reserve1: reserve1.toString(),
        tvlUsd: tvlUsd.toFixed(0)
      };
    } catch (err) {
      console.log(`[Liquidity] Error fetching ${name}: ${err.message}`);
      liquidity[name] = { error: err.message };
    }
  }

  return liquidity;
}

// V3 Pool ABI (minimal for liquidity check)
const V3_POOL_ABI = [
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

const ERC20_DECIMALS_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

/**
 * Get FlowSwap V3 liquidity for configured pools
 * @returns {Promise<Object>} Liquidity info for each pool
 */
async function getV3Liquidity() {
  const pools = config.contracts.flowswapV3?.pools || {};
  const liquidity = {};

  for (const [name, poolAddress] of Object.entries(pools)) {
    try {
      const poolContract = new Contract(poolAddress, V3_POOL_ABI, provider);
      const [token0, token1] = await Promise.all([
        poolContract.token0(),
        poolContract.token1()
      ]);

      // Get token balances in pool (more accurate than liquidity() for TVL)
      const tok0Contract = new Contract(token0, ERC20_DECIMALS_ABI, provider);
      const tok1Contract = new Contract(token1, ERC20_DECIMALS_ABI, provider);

      const [bal0, bal1, dec0, dec1] = await Promise.all([
        tok0Contract.balanceOf(poolAddress),
        tok1Contract.balanceOf(poolAddress),
        tok0Contract.decimals(),
        tok1Contract.decimals()
      ]);

      const balance0 = Number(bal0.toString()) / Math.pow(10, dec0);
      const balance1 = Number(bal1.toString()) / Math.pow(10, dec1);

      // Calculate TVL
      const isToken0Stable = token0.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();
      const isToken1Stable = token1.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();

      let tvlUsd;
      if (isToken0Stable) {
        tvlUsd = balance0 * 2;
      } else if (isToken1Stable) {
        tvlUsd = balance1 * 2;
      } else {
        // Both non-stable (e.g., ankrFLOW/WFLOW), use WFLOW price
        const flowPrice = await getCachedPrice(config.contracts.tokens?.WFLOW || token0);
        const flowPriceUsd = Number(flowPrice.toString()) / 1e8;
        const wflowBal = token0.toLowerCase() === config.contracts.tokens?.WFLOW?.toLowerCase() ? balance0 : balance1;
        tvlUsd = wflowBal * flowPriceUsd * 2;
      }

      liquidity[name] = {
        pool: poolAddress,
        tvlUsd: tvlUsd.toFixed(0)
      };
    } catch (err) {
      console.log(`[V3 Liquidity] Error fetching ${name}: ${err.message}`);
      liquidity[name] = { error: err.message };
    }
  }

  return liquidity;
}

// ============================================
// CACHE SYSTEM - Reduce RPC calls
// ============================================
const CACHE_TTL_MS = 5000; // 5 seconds TTL for prices (faster updates)
const priceCache = new Map(); // token -> { price, timestamp }
const reserveConfigCache = new Map(); // token -> { config, timestamp }

async function getCachedPrice(token) {
  const now = Date.now();
  const cached = priceCache.get(token.toLowerCase());

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.price;
  }

  const price = await oracleContract.getAssetPrice(token);
  priceCache.set(token.toLowerCase(), { price, timestamp: now });
  return price;
}

async function getCachedReserveConfig(token) {
  const now = Date.now();
  const cached = reserveConfigCache.get(token.toLowerCase());

  // Reserve config changes rarely, cache for 60 seconds
  if (cached && (now - cached.timestamp) < 60000) {
    return cached.config;
  }

  const config = await dataProviderContract.getReserveConfigurationData(token);
  reserveConfigCache.set(token.toLowerCase(), { config, timestamp: now });
  return config;
}

// Batch fetch multiple prices at once
async function batchGetPrices(tokens) {
  const uniqueTokens = [...new Set(tokens.map(t => t.toLowerCase()))];
  const uncachedTokens = [];
  const result = {};
  const now = Date.now();

  // Check cache first
  for (const token of uniqueTokens) {
    const cached = priceCache.get(token);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      result[token] = cached.price;
    } else {
      uncachedTokens.push(token);
    }
  }

  // Fetch uncached prices via multicall
  if (uncachedTokens.length > 0) {
    const priceRequests = uncachedTokens.map(token => ({
      target: config.contracts.oracle,
      callData: new utils.Interface(AaveOracleAbi).encodeFunctionData("getAssetPrice", [token])
    }));

    try {
      const priceRes = await multicallContract.callStatic.aggregate(priceRequests);
      const oracleInterface = new utils.Interface(AaveOracleAbi);

      priceRes.returnData.forEach((data, idx) => {
        const decoded = oracleInterface.decodeFunctionResult("getAssetPrice", data);
        const price = BigNumber.from(decoded[0]);
        const token = uncachedTokens[idx];
        priceCache.set(token, { price, timestamp: now });
        result[token] = price;
      });
    } catch (err) {
      console.error("[Cache] Batch price fetch failed, falling back to individual:", err.message);
      for (const token of uncachedTokens) {
        result[token] = await oracleContract.getAssetPrice(token);
        priceCache.set(token, { price: result[token], timestamp: now });
      }
    }
  }

  return result;
}

// ============================================
// HOT POSITIONS TRACKER
// ============================================
// Track positions close to liquidation with pre-calculated trigger prices
const hotPositions = new Map(); // user -> { hf, debt, collaterals, triggerPrices, lastUpdate }

// ============================================
// POSITION BLACKLIST (FAILED LIQUIDATIONS)
// ============================================
// Track positions that consistently fail with negative rewards to avoid infinite loops
const failedPositions = new Map(); // user -> { failures, lastAttempt, reason }
const MAX_FAILURES_BEFORE_BLACKLIST = 3; // Skip after 3 consecutive failures
const BLACKLIST_TTL_MS = 5 * 60 * 1000; // Clear blacklist after 5 minutes (market conditions may change)

/**
 * Record a failed liquidation attempt
 * @param {string} user - User address
 * @param {string} reason - Reason for failure
 */
function recordFailedLiquidation(user, reason) {
  const existing = failedPositions.get(user) || { failures: 0, lastAttempt: 0, reason: '' };
  failedPositions.set(user, {
    failures: existing.failures + 1,
    lastAttempt: Date.now(),
    reason
  });
}

/**
 * Check if position should be skipped due to repeated failures
 * @param {string} user - User address
 * @returns {boolean} True if should skip
 */
function shouldSkipPosition(user) {
  const failed = failedPositions.get(user);
  if (!failed) return false;

  // Clear old entries (older than BLACKLIST_TTL_MS)
  if (Date.now() - failed.lastAttempt > BLACKLIST_TTL_MS) {
    failedPositions.delete(user);
    return false;
  }

  return failed.failures >= MAX_FAILURES_BEFORE_BLACKLIST;
}

/**
 * Clear successful liquidations from blacklist
 * @param {string} user - User address
 */
function clearFailedPosition(user) {
  failedPositions.delete(user);
}

// ============================================
// ADAPTIVE LIQUIDATION PERCENTAGES
// ============================================
// Try different liquidation percentages to find the optimal one
const LIQUIDATION_PERCENTAGES = [10n, 25n, 50n]; // Try 10%, 25%, then 50%

/**
 * Try different liquidation percentages to find the most profitable one
 * @param {BigNumber} userDebt - Total user debt
 * @param {Object} context - Liquidation context (collateral, debt assets, etc.)
 * @returns {Object} Best percentage and expected profit
 */
async function findOptimalLiquidationPercentage(userDebt, context) {
  const results = [];

  for (const percentage of LIQUIDATION_PERCENTAGES) {
    try {
      const debtToCover = userDebt.mul(percentage).div(100n);

      // Add interest buffer
      const INTEREST_BUFFER_BPS = 10n;
      const debtWithBuffer = debtToCover.mul(10000n + INTEREST_BUFFER_BPS).div(10000n);

      // Calculate expected profit for this percentage
      const profitEstimate = await estimateLiquidationProfit(debtWithBuffer, context);

      results.push({
        percentage: Number(percentage),
        debtToCover: debtWithBuffer,
        estimatedProfit: profitEstimate.profitUsd,
        profitPerGas: profitEstimate.profitUsd / profitEstimate.estimatedGas
      });

      console.log(`  [Adaptive] ${percentage}%: profit $${profitEstimate.profitUsd.toFixed(2)}, gas efficiency ${(profitEstimate.profitUsd / profitEstimate.estimatedGas * 1000).toFixed(2)}`);

      // If not profitable, don't try higher percentages
      if (profitEstimate.profitUsd <= 0) {
        break;
      }
    } catch (error) {
      console.log(`  [Adaptive] ${percentage}% failed:`, error.message);
      break;
    }
  }

  if (results.length === 0 || results.every(r => r.estimatedProfit <= 0)) {
    return null; // No profitable percentage found
  }

  // Return the percentage with best profit per gas ratio
  const best = results
    .filter(r => r.estimatedProfit > 0)
    .sort((a, b) => b.profitPerGas - a.profitPerGas)[0];

  console.log(`  [Adaptive] ✅ Using ${best.percentage}% (best profit/gas ratio)`);
  return best;
}

/**
 * Estimate profit for a given liquidation amount
 * @param {BigNumber} debtToCover - Debt amount to liquidate
 * @param {Object} context - Liquidation context
 * @returns {Object} Profit estimate
 */
async function estimateLiquidationProfit(debtToCover, context) {
  const { collateralAsset, debtAsset, collateralDecimals, debtDecimals, strategyResult } = context;

  // Calculate total needed including fees
  let totalNeeded;
  if (strategyResult.strategy === Strategy.V2_FLASH_SWAP) {
    const flashSwapFee = debtToCover.mul(FLASH_SWAP_FEE_BPS).div(10000n);
    totalNeeded = debtToCover.add(flashSwapFee);
  } else if (strategyResult.strategy === Strategy.V3_FLASH) {
    const v3Fee = strategyResult.fee || 30;
    const flashFee = debtToCover.mul(BigInt(v3Fee)).div(10000n);
    totalNeeded = debtToCover.add(flashFee);
  } else {
    const flashLoanPremium = debtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
    totalNeeded = debtToCover.add(flashLoanPremium);
  }

  // Calculate expected collateral
  const expectedCollateral = await calculateExpectedCollateral(
    totalNeeded,
    collateralAsset,
    debtAsset,
    collateralDecimals,
    debtDecimals
  );

  // Estimate swap output (collateral -> debt)
  const swapOutput = await estimateSwapOutput(
    expectedCollateral,
    collateralAsset,
    debtAsset,
    strategyResult
  );

  // Profit = swap output - total needed
  const profitInDebtToken = swapOutput.sub(totalNeeded);
  const profitUsd = Number(profitInDebtToken.toString()) / Math.pow(10, debtDecimals) * 0.9999; // Assume USDF ≈ $1

  // Estimate gas (rough)
  const estimatedGas = strategyResult.strategy === Strategy.EISEN_FLASH_LOAN ? 500000 : 300000;

  return {
    profitUsd,
    estimatedGas,
    swapOutput,
    totalNeeded
  };
}

/**
 * Estimate swap output for collateral -> debt conversion
 * @param {BigNumber} collateralAmount - Amount of collateral
 * @param {string} collateralAsset - Collateral token address
 * @param {string} debtAsset - Debt token address
 * @param {Object} strategyResult - Selected strategy
 * @returns {BigNumber} Estimated output in debt token
 */
async function estimateSwapOutput(collateralAmount, collateralAsset, debtAsset, strategyResult) {
  // Simple estimation based on oracle prices (will be pessimistic if pool price is worse)
  const oracleCollateralPrice = await oracleContract.getAssetPrice(collateralAsset);
  const oracleDebtPrice = await oracleContract.getAssetPrice(debtAsset);

  // Convert collateral value to debt token amount
  // This is optimistic - actual swap will be worse due to slippage
  const collateralValueInDebt = collateralAmount
    .mul(oracleCollateralPrice)
    .div(oracleDebtPrice);

  // Apply estimated slippage based on strategy
  let slippageFactor;
  if (strategyResult.strategy === Strategy.V2_FLASH_SWAP) {
    slippageFactor = 970n; // 3% slippage
  } else if (strategyResult.strategy === Strategy.V3_FLASH) {
    slippageFactor = 990n; // 1% slippage
  } else {
    slippageFactor = 950n; // 5% slippage for aggregator
  }

  return collateralValueInDebt.mul(slippageFactor).div(1000n);
}

// ============================================
// PREPARED LIQUIDATIONS CACHE
// ============================================
// Pre-calculated liquidation params ready to execute instantly
const preparedLiquidations = new Map(); // user -> { params, strategy, timestamp, debtToCover, collateral }
const preparingUsers = new Set(); // Users currently being prepared (to avoid duplicate work)
const PREPARED_TTL_MS = 30000; // Params válidos por 30 segundos

/**
 * Preparar liquidation params para una posición HOT
 * Se ejecuta en background para posiciones con HF < 1.05
 */
async function prepareLiquidationParams(user, pool, totalDebtBase) {
  // Skip if already preparing or prepared
  if (preparingUsers.has(user) || preparedLiquidations.has(user)) return null;
  preparingUsers.add(user);

  const botInfo = config.bots[pool];
  if (!botInfo) {
    preparingUsers.delete(user);
    return null;
  }

  try {
    // Fetch user's token balances
    let mTokenRequest = [];
    botInfo.mTokens.forEach((mToken) => {
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [user]),
      });
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", []),
      });
    });

    botInfo.dTokens.forEach((dToken) => {
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [user]),
      });
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", []),
      });
    });

    const tokenRes = await multicallContract.callStatic.aggregate(mTokenRequest);

    let mInfos = [];
    let dInfos = [];
    let tokensWithUnderlying = [];

    const tokenInfos = tokenRes[1].map((res, ind) => ({
      info: mTokenInterface.decodeFunctionResult(
        ind % 2 == 0 ? "balanceOf" : "UNDERLYING_ASSET_ADDRESS",
        res
      ),
    }));

    for (let ii = 0; ii < tokenInfos.length; ii++) {
      const selInd = ii % 2;
      if (selInd == 0) {
        const detailedInfo = tokenInfos[ii].info[0];
        if (detailedInfo.gt(0)) {
          if (ii < botInfo.mTokens.length * 2) {
            mInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          } else {
            dInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          }
        }
      } else if (ii < botInfo.mTokens.length * 2) {
        const detailedInfo = tokenInfos[ii].info[0].toLowerCase();
        const idx = tokensWithUnderlying.findIndex(t => t.token == detailedInfo);
        if (idx < 0) {
          tokensWithUnderlying.push({
            token: detailedInfo,
            mtoken: botInfo.mTokens[Math.floor(ii / 2)],
          });
        }
      }
    }

    if (mInfos.length === 0 || dInfos.length === 0) return null;

    const debtAsset = dInfos[0].token[0];
    const debtMToken = tokensWithUnderlying.find(t => t.token == debtAsset.toLowerCase());
    if (!debtMToken) return null;

    const debtContract = new Contract(debtAsset, MTokenAbi, provider);
    const [debtBalanceInmToken, debtDecimals] = await Promise.all([
      debtContract.balanceOf(debtMToken.mtoken),
      debtContract.decimals()
    ]);
    const userDebt = dInfos[0].amount;

    const collateralAsset = mInfos[0].token[0];
    const collateralContract = new Contract(collateralAsset, MTokenAbi, provider);
    const collateralDecimals = await collateralContract.decimals();

    // Calculate debt value for slippage
    const debtValueUsd = Number(totalDebtBase.toString()) / 1e8;
    const dynamicSlippage = calculateDynamicSlippage(debtValueUsd);

    // Select strategy FIRST (needed for adaptive calculation)
    const strategyResult = await selectBestStrategy(
      collateralAsset,
      debtAsset,
      userDebt.div(2n), // Use 50% for initial strategy selection
      BigNumber.from(0),
      provider
    );

    // 🔥 ADAPTIVE LIQUIDATION: Try different percentages to find optimal
    console.log(`[Adaptive] Testing liquidation percentages for ${shortAddr(user)}...`);
    const adaptiveResult = await findOptimalLiquidationPercentage(userDebt, {
      collateralAsset,
      debtAsset,
      collateralDecimals,
      debtDecimals,
      strategyResult
    });

    if (!adaptiveResult) {
      console.log(`[Prepared] Error for ${shortAddr(user)}: No profitable percentage found`);
      // Record as failed to blacklist
      recordFailedLiquidation(user, 'No profitable percentage');
      preparingUsers.delete(user);
      return null;
    }

    let debtToCover = adaptiveResult.debtToCover;

    // Cap to available debt in pool
    debtToCover = userDebt.gt(debtBalanceInmToken)
      ? (debtBalanceInmToken.gt(debtToCover) ? debtToCover : debtBalanceInmToken)
      : debtToCover;

    // Calculate expected collateral based on strategy
    let totalNeeded;
    if (strategyResult.strategy === Strategy.V2_FLASH_SWAP) {
      const flashSwapFee = debtToCover.mul(FLASH_SWAP_FEE_BPS).div(10000n);
      totalNeeded = debtToCover.add(flashSwapFee);
    } else if (strategyResult.strategy === Strategy.V3_FLASH) {
      const v3Fee = strategyResult.fee || 30;
      const flashFee = debtToCover.mul(BigInt(v3Fee)).div(10000n);
      totalNeeded = debtToCover.add(flashFee);
    } else {
      const flashLoanPremium = debtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
      totalNeeded = debtToCover.add(flashLoanPremium);
    }

    const expectedCollateral = await calculateExpectedCollateral(
      totalNeeded,
      collateralAsset,
      debtAsset,
      collateralDecimals,
      debtDecimals
    );

    // Build swap params based on strategy
    let sParamToRepayLoan, sParamToSendToReceiver;

    if (strategyResult.strategy === Strategy.EISEN_FLASH_LOAN) {
      const params = await buildLiquidationParams({
        collateralAsset,
        debtAsset,
        totalNeeded,
        collateralAmount: expectedCollateral,
        contractAddress: botInfo.bot,
        receiverAddress: new Wallet(config.liquidator_key).address,
        apiKey: config.eisen_api_key,
        slippage: dynamicSlippage
      });
      sParamToRepayLoan = params.sParamToRepayLoan;
      sParamToSendToReceiver = params.sParamToSendToReceiver;
    } else {
      const params = await buildFlashSwapLiquidationParams({
        collateralAsset,
        debtAsset,
        debtAmount: debtToCover,
        collateralAmount: expectedCollateral,
        router: PUNCHSWAP_ROUTER,
        wflow: WFLOW,
        slippage: dynamicSlippage,
        provider
      });
      sParamToRepayLoan = params.sParamToRepayLoan;
      sParamToSendToReceiver = params.sParamToSendToReceiver;
    }

    const prepared = {
      user,
      pool,
      botAddress: botInfo.bot,
      collateralAsset,
      debtAsset,
      debtToCover,
      debtBalanceInmToken,
      userDebt,
      expectedCollateral,
      debtDecimals,
      collateralDecimals,
      strategy: strategyResult.strategy,
      strategyPool: strategyResult.pool,
      sParamToRepayLoan,
      sParamToSendToReceiver,
      totalNeeded,
      slippage: dynamicSlippage,
      timestamp: Date.now()
    };

    preparedLiquidations.set(user, prepared);
    preparingUsers.delete(user);
    console.log(`[Prepared] ${shortAddr(user)} - ${strategyResult.strategy} ready`);
    return prepared;

  } catch (err) {
    preparingUsers.delete(user);
    console.log(`[Prepared] Error for ${shortAddr(user)}: ${err.message?.slice(0, 60)}`);
    return null;
  }
}

/**
 * Get valid prepared params (not expired)
 */
function getPreparedParams(user) {
  const prepared = preparedLiquidations.get(user);
  if (!prepared) return null;
  if (Date.now() - prepared.timestamp > PREPARED_TTL_MS) {
    preparedLiquidations.delete(user);
    return null;
  }
  return prepared;
}

/**
 * Clean expired prepared params
 */
function cleanExpiredPrepared() {
  const now = Date.now();
  for (const [user, data] of preparedLiquidations.entries()) {
    if (now - data.timestamp > PREPARED_TTL_MS) {
      preparedLiquidations.delete(user);
    }
  }
}

/**
 * BATCH prepare liquidation params for multiple positions
 * Much more efficient than calling prepareLiquidationParams() for each
 *
 * @param {Array} positions - Array of { user, pool, totalDebtBase }
 * @returns {Object} { prepared: number, failed: number, timing: { balances, quotes, total } }
 */
// Max users per batch to avoid RPC limits (~7M gas at 50 users)
const BATCH_CHUNK_SIZE = 50;

async function batchPreparePositions(positions) {
  if (!positions || positions.length === 0) return { prepared: 0, failed: 0, timing: {} };

  const pool = positions[0].pool;
  const botInfo = config.bots[pool];
  if (!botInfo) return { prepared: 0, failed: 0, timing: {} };

  const timingStart = Date.now();
  const timing = {};

  // Filter out already preparing/prepared users
  const toProcess = positions.filter(p =>
    !preparingUsers.has(p.user) && !preparedLiquidations.has(p.user)
  );

  if (toProcess.length === 0) return { prepared: 0, failed: 0, timing: {} };

  // If too many users, process in chunks to avoid RPC limits
  if (toProcess.length > BATCH_CHUNK_SIZE) {
    console.log(`[BatchPrepare] ${toProcess.length} users > ${BATCH_CHUNK_SIZE} limit, chunking...`);
    let totalPrepared = 0;
    let totalFailed = 0;

    for (let i = 0; i < toProcess.length; i += BATCH_CHUNK_SIZE) {
      const chunk = toProcess.slice(i, i + BATCH_CHUNK_SIZE);
      console.log(`[BatchPrepare] Chunk ${Math.floor(i/BATCH_CHUNK_SIZE) + 1}/${Math.ceil(toProcess.length/BATCH_CHUNK_SIZE)}: ${chunk.length} users`);

      const result = await batchPreparePositions(chunk);
      totalPrepared += result.prepared;
      totalFailed += result.failed;
    }

    return { prepared: totalPrepared, failed: totalFailed, timing: { total: Date.now() - timingStart } };
  }

  // Mark all as preparing
  toProcess.forEach(p => preparingUsers.add(p.user));

  console.log(`[BatchPrepare] Processing ${toProcess.length} positions...`);

  try {
    // ═══════════════════════════════════════════════════════════════
    // STEP 1: Batch get all mToken/dToken balances for all users
    // ═══════════════════════════════════════════════════════════════
    const balanceStart = Date.now();
    const balanceCalls = [];
    const callsPerUser = (botInfo.mTokens.length + botInfo.dTokens.length) * 2;

    for (const pos of toProcess) {
      // mTokens: balanceOf + UNDERLYING_ASSET_ADDRESS
      for (const mToken of botInfo.mTokens) {
        balanceCalls.push({
          target: mToken,
          callData: mTokenInterface.encodeFunctionData("balanceOf", [pos.user])
        });
        balanceCalls.push({
          target: mToken,
          callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", [])
        });
      }
      // dTokens: balanceOf + UNDERLYING_ASSET_ADDRESS
      for (const dToken of botInfo.dTokens) {
        balanceCalls.push({
          target: dToken,
          callData: mTokenInterface.encodeFunctionData("balanceOf", [pos.user])
        });
        balanceCalls.push({
          target: dToken,
          callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", [])
        });
      }
    }

    const balanceResults = await multicallContract.callStatic.aggregate(balanceCalls);
    timing.balances = Date.now() - balanceStart;

    // ═══════════════════════════════════════════════════════════════
    // STEP 2: Parse balance results to find collateral/debt per user
    // ═══════════════════════════════════════════════════════════════
    const userAssets = new Map(); // user -> { collateralAsset, debtAsset, collateralAmount, debtAmount, ... }

    for (let userIdx = 0; userIdx < toProcess.length; userIdx++) {
      const pos = toProcess[userIdx];
      const startIdx = userIdx * callsPerUser;

      const mInfos = [];
      const dInfos = [];
      const tokensWithUnderlying = [];

      let callIdx = startIdx;

      // Parse mToken results
      for (let i = 0; i < botInfo.mTokens.length; i++) {
        const balanceData = balanceResults.returnData[callIdx];
        const underlyingData = balanceResults.returnData[callIdx + 1];

        const balance = mTokenInterface.decodeFunctionResult("balanceOf", balanceData)[0];
        const underlying = mTokenInterface.decodeFunctionResult("UNDERLYING_ASSET_ADDRESS", underlyingData)[0];

        if (balance.gt(0)) {
          mInfos.push({ token: underlying, amount: balance });
        }
        tokensWithUnderlying.push({
          token: underlying.toLowerCase(),
          mtoken: botInfo.mTokens[i]
        });

        callIdx += 2;
      }

      // Parse dToken results
      for (let i = 0; i < botInfo.dTokens.length; i++) {
        const balanceData = balanceResults.returnData[callIdx];
        const underlyingData = balanceResults.returnData[callIdx + 1];

        const balance = mTokenInterface.decodeFunctionResult("balanceOf", balanceData)[0];
        const underlying = mTokenInterface.decodeFunctionResult("UNDERLYING_ASSET_ADDRESS", underlyingData)[0];

        if (balance.gt(0)) {
          dInfos.push({ token: underlying, amount: balance });
        }

        callIdx += 2;
      }

      // Skip if no collateral or debt
      if (mInfos.length === 0 || dInfos.length === 0) {
        preparingUsers.delete(pos.user);
        continue;
      }

      const collateralAsset = mInfos[0].token;
      const debtAsset = dInfos[0].token;
      const debtMToken = tokensWithUnderlying.find(t => t.token === debtAsset.toLowerCase());

      if (!debtMToken) {
        preparingUsers.delete(pos.user);
        continue;
      }

      userAssets.set(pos.user, {
        collateralAsset,
        debtAsset,
        collateralAmount: mInfos[0].amount,
        debtAmount: dInfos[0].amount,
        debtMToken: debtMToken.mtoken,
        totalDebtBase: pos.totalDebtBase,
        pool: pos.pool
      });
    }

    if (userAssets.size === 0) {
      toProcess.forEach(p => preparingUsers.delete(p.user));
      return { prepared: 0, failed: toProcess.length, timing };
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 3: Get decimals and additional info (batch)
    // ═══════════════════════════════════════════════════════════════
    const uniqueTokens = new Set();
    for (const assets of userAssets.values()) {
      uniqueTokens.add(assets.collateralAsset);
      uniqueTokens.add(assets.debtAsset);
    }

    const decimalCalls = Array.from(uniqueTokens).map(token => ({
      target: token,
      callData: mTokenInterface.encodeFunctionData("decimals", [])
    }));

    const decimalResults = await multicallContract.callStatic.aggregate(decimalCalls);
    const decimalsMap = new Map();
    Array.from(uniqueTokens).forEach((token, idx) => {
      const dec = mTokenInterface.decodeFunctionResult("decimals", decimalResults.returnData[idx])[0];
      decimalsMap.set(token.toLowerCase(), dec);
    });

    // ═══════════════════════════════════════════════════════════════
    // STEP 4: Batch get oracle prices for all tokens
    // ═══════════════════════════════════════════════════════════════
    const oracleStart = Date.now();
    const oracleInterface = new utils.Interface(AaveOracleAbi);
    const oracleCalls = Array.from(uniqueTokens).map(token => ({
      target: config.contracts.oracle,
      callData: oracleInterface.encodeFunctionData("getAssetPrice", [token])
    }));

    const oracleResults = await multicallContract.callStatic.aggregate(oracleCalls);
    const priceMap = new Map();
    Array.from(uniqueTokens).forEach((token, idx) => {
      const price = oracleInterface.decodeFunctionResult("getAssetPrice", oracleResults.returnData[idx])[0];
      priceMap.set(token.toLowerCase(), price);
    });
    timing.oracle = Date.now() - oracleStart;

    // ═══════════════════════════════════════════════════════════════
    // STEP 5: Build quote pairs for ALL percentages (10%, 25%, 50%)
    // ═══════════════════════════════════════════════════════════════
    const quoteStart = Date.now();
    const quotePairs = [];
    const PERCENTAGES = [10n, 25n, 50n]; // Test 10%, 25%, 50%
    const LIQUIDATION_BONUS = 1050n; // 5% bonus

    for (const [user, assets] of userAssets) {
      // Select strategy (doesn't need RPC, just pool config lookup)
      const strategyResult = await selectBestStrategy(
        assets.debtAsset,
        assets.collateralAsset,
        assets.debtAmount,
        provider
      );

      const collateralDecimals = decimalsMap.get(assets.collateralAsset.toLowerCase());
      const debtDecimals = decimalsMap.get(assets.debtAsset.toLowerCase());
      const collateralPrice = priceMap.get(assets.collateralAsset.toLowerCase());
      const debtPrice = priceMap.get(assets.debtAsset.toLowerCase());

      // Store basic info
      assets.strategyResult = strategyResult;
      assets.collateralDecimals = collateralDecimals;
      assets.debtDecimals = debtDecimals;
      assets.collateralPrice = collateralPrice;
      assets.debtPrice = debtPrice;

      // Add quote pair for EACH percentage
      for (const pct of PERCENTAGES) {
        // Calculate debt to liquidate for this percentage
        const debtToLiquidate = assets.debtAmount.mul(pct).div(100n);

        // Expected collateral = debt * debtPrice / collateralPrice * (1 + bonus)
        const expectedCollateral = debtToLiquidate
          .mul(debtPrice)
          .mul(LIQUIDATION_BONUS)
          .div(collateralPrice)
          .div(1000n);

        quotePairs.push({
          tokenIn: assets.collateralAsset,
          tokenOut: assets.debtAsset,
          amountIn: expectedCollateral,
          id: `${user}|${pct}` // Format: user|percentage
        });
      }
    }

    // Batch get ALL quotes for ALL users and ALL percentages in ONE multicall
    const quotes = await batchGetSwapQuotes(
      quotePairs,
      config.contracts.multicall,
      config.contracts.punchswap.router,
      provider
    );
    timing.quotes = Date.now() - quoteStart;

    // ═══════════════════════════════════════════════════════════════
    // STEP 6: Group quotes by user and select best percentage
    // ═══════════════════════════════════════════════════════════════
    let preparedCount = 0;
    let failedCount = 0;

    // Group quotes by user
    const quotesByUser = new Map();
    for (const quote of quotes) {
      const [user, pctStr] = quote.id.split('|');
      const pct = BigInt(pctStr);

      if (!quotesByUser.has(user)) {
        quotesByUser.set(user, []);
      }
      quotesByUser.get(user).push({ quote, pct });
    }

    // Process each user and find best percentage
    for (const [user, userQuotes] of quotesByUser) {
      const assets = userAssets.get(user);

      if (!assets) {
        preparingUsers.delete(user);
        failedCount++;
        continue;
      }

      // Calculate profit for each percentage and find the best
      let bestOption = null;
      let bestProfitUsd = -Infinity;

      for (const { quote, pct } of userQuotes) {
        if (!quote.best) continue;

        const debtToLiquidate = assets.debtAmount.mul(pct).div(100n);
        const swapOutput = quote.best.amountOut;

        // Calculate fees based on strategy
        let totalFees;
        if (assets.strategyResult.strategy === Strategy.V2_FLASH_SWAP) {
          totalFees = debtToLiquidate.mul(30).div(10000); // 0.3%
        } else if (assets.strategyResult.strategy === Strategy.V3_FLASH) {
          const fee = assets.strategyResult.fee || 30;
          totalFees = debtToLiquidate.mul(BigInt(fee)).div(10000);
        } else {
          totalFees = debtToLiquidate.mul(5).div(10000); // 0.05% flash loan
        }

        const profitInDebtToken = swapOutput.sub(debtToLiquidate).sub(totalFees);
        const profitUsd = Number(profitInDebtToken.toString()) / Math.pow(10, assets.debtDecimals);

        // Calculate expected collateral for this percentage
        const expectedCollateral = debtToLiquidate
          .mul(assets.debtPrice)
          .mul(1050n) // 5% bonus
          .div(assets.collateralPrice)
          .div(1000n);

        if (profitUsd > bestProfitUsd) {
          bestProfitUsd = profitUsd;
          bestOption = {
            pct,
            quote: quote.best,
            debtToLiquidate,
            expectedCollateral,
            profitUsd
          };
        }
      }

      if (!bestOption || bestOption.profitUsd <= 0) {
        preparingUsers.delete(user);
        failedCount++;
        console.log(`[BatchPrepare] ${shortAddr(user)} skipped - no profitable %`);
        continue;
      }

      // Store prepared params with BEST percentage
      const prepared = {
        user,
        pool: assets.pool,
        botAddress: config.bots[assets.pool].bot,
        collateralAsset: assets.collateralAsset,
        debtAsset: assets.debtAsset,
        collateralDecimals: assets.collateralDecimals,
        debtDecimals: assets.debtDecimals,
        debtToCover: bestOption.debtToLiquidate,
        userDebt: assets.debtAmount,
        debtBalanceInmToken: assets.debtAmount,
        expectedCollateral: bestOption.expectedCollateral,
        strategyResult: assets.strategyResult,
        quote: bestOption.quote,
        liquidationPct: Number(bestOption.pct),
        estimatedProfitUsd: bestOption.profitUsd,
        timestamp: Date.now()
      };

      preparedLiquidations.set(user, prepared);
      preparingUsers.delete(user);
      preparedCount++;

      const profitStr = bestOption.profitUsd >= 0 ? `+$${bestOption.profitUsd.toFixed(2)}` : `-$${Math.abs(bestOption.profitUsd).toFixed(2)}`;
      console.log(`[BatchPrepare] ${shortAddr(user)} ready - ${bestOption.pct}% ${bestOption.quote.type} ${profitStr}`);
    }

    timing.total = Date.now() - timingStart;

    console.log(`[BatchPrepare] Done: ${preparedCount} prepared, ${failedCount} failed`);
    console.log(`[BatchPrepare] Timing: balances=${timing.balances}ms, oracle=${timing.oracle}ms, quotes=${timing.quotes}ms, total=${timing.total}ms`);
    console.log(`[BatchPrepare] Efficiency: ${userAssets.size} users × 3 pcts = ${quotePairs.length} quotes in 1 multicall`);

    return { prepared: preparedCount, failed: failedCount, timing };

  } catch (err) {
    console.error(`[BatchPrepare] Error: ${err.message}`);
    toProcess.forEach(p => preparingUsers.delete(p.user));
    return { prepared: 0, failed: toProcess.length, timing };
  }
}

// Calculate % price drop needed to trigger liquidation
function calculatePriceDropToLiquidate(currentHF) {
  // HF = collateralValue * LT / debt
  // If collateral price drops by X%, new HF = currentHF * (1 - X)
  // For HF to reach 1.0: 1.0 = currentHF * (1 - X)
  // X = 1 - (1.0 / currentHF)
  const hfFloat = Number(currentHF.toString()) / 1e18;
  return (1 - (1.0 / hfFloat)) * 100; // Return as percentage
}

// Helper to shorten address
const shortAddr = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

// Telegram bot instance (reused)
let telegramBot = null;
const getTelegramBot = () => {
  if (!telegramBot) {
    telegramBot = new Telegraf(config.bot_token);
  }
  return telegramBot;
};

// Send Telegram message helper
const sendAlert = async (message) => {
  try {
    await getTelegramBot().telegram.sendMessage(config.alert_chat_id, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
};

const sendInfo = async (message) => {
  try {
    await getTelegramBot().telegram.sendMessage(config.info_chat_id, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
};

// State management for periodic reports
const loadState = () => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error("Error loading state:", err.message);
  }
  return { lastReportTime: 0 };
};

const saveState = (state) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Error saving state:", err.message);
  }
};

const shouldSendReport = (state) => {
  const reportIntervalMs = (config.report_interval_hours || 1) * 60 * 60 * 1000;
  return Date.now() - state.lastReportTime >= reportIntervalMs;
};

const apolloFetcher = async (query) => {
  const client = new ApolloClient({
    link: new HttpLink({
      uri: config.subgraph_url,
    }),
    cache: new InMemoryCache(),
  });

  return client.query({
    query: query.query,
    variables: query.variables,
  });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry helper with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelayMs = 1000, operationName = 'operation') {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable = err.message?.includes('missing revert data') ||
                          err.message?.includes('CALL_EXCEPTION') ||
                          err.message?.includes('timeout') ||
                          err.message?.includes('ETIMEDOUT') ||
                          err.message?.includes('processing response error') ||
                          err.code === 'NETWORK_ERROR' ||
                          err.code === 'TIMEOUT';

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.log(`[Retry] ${operationName} failed (attempt ${attempt}/${maxRetries}): ${err.message?.slice(0, 80)}`);
      console.log(`[Retry] Waiting ${delay}ms before retry...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Calculate expected collateral using Aave liquidation formula
 * Returns 95% of theoretical to prevent SwapFailed errors
 *
 * Formula: collateral = (debtToCover × debtPrice × liquidationBonus) / (collateralPrice × 10000)
 */
async function calculateExpectedCollateral(
  debtToCover,
  collateralAsset,
  debtAsset,
  collateralDecimals,
  debtDecimals
) {
  // Get prices from cache (8 decimals)
  const [debtPrice, collateralPrice] = await Promise.all([
    getCachedPrice(debtAsset),
    getCachedPrice(collateralAsset)
  ]);

  // Get liquidation bonus from cache
  const reserveConfig = await getCachedReserveConfig(collateralAsset);
  const liquidationBonus = BigNumber.from(reserveConfig.liquidationBonus);

  // Calculate theoretical collateral
  // collateral = (debtToCover * debtPrice * liquidationBonus) / (collateralPrice * 10000)
  let theoreticalCollateral = debtToCover
    .mul(debtPrice)
    .mul(liquidationBonus)
    .div(collateralPrice)
    .div(10000);

  // Adjust for decimals difference
  if (collateralDecimals > debtDecimals) {
    theoreticalCollateral = theoreticalCollateral.mul(
      BigNumber.from(10).pow(collateralDecimals - debtDecimals)
    );
  } else if (collateralDecimals < debtDecimals) {
    theoreticalCollateral = theoreticalCollateral.div(
      BigNumber.from(10).pow(debtDecimals - collateralDecimals)
    );
  }

  // Apply conservative factor (95%) to prevent SwapFailed errors
  // Actual collateral received can be slightly less due to interest accrual and rounding
  const conservativeCollateral = theoreticalCollateral.mul(CONSERVATIVE_FACTOR).div(100n);

  console.log(`[Collateral] Theoretical: ${theoreticalCollateral.toString()}`);
  console.log(`[Collateral] Conservative (${CONSERVATIVE_FACTOR}%): ${conservativeCollateral.toString()}`);

  return conservativeCollateral;
}

/**
 * Build liquidation params based on whether debt is WFLOW or not
 *
 * Case 1: debtAsset == WFLOW -> Simple (1 swap): collateral -> WFLOW
 * Case 2: debtAsset != WFLOW -> Complex (2 swaps): collateral -> debt, debt -> WFLOW
 */
async function buildLiquidationParams({
  collateralAsset,
  debtAsset,
  totalNeeded, // debt + premium - minimum amount swap must return
  collateralAmount,
  contractAddress,
  receiverAddress,
  apiKey,
  slippage = 0.02 // Default 2%, can be increased on retry
}) {
  const isWFLOWDebt = debtAsset.toLowerCase() === WFLOW.toLowerCase();

  console.log(`[Liquidation] Using slippage: ${(slippage * 100).toFixed(1)}%`);

  if (isWFLOWDebt) {
    // SIMPLE CASE: Only 1 swap needed (collateral -> WFLOW)
    console.log('[Liquidation] Simple case: debtAsset is WFLOW, 1 swap needed');

    const { swapParams: sParamToRepayLoan, quote } = await buildSwapParams({
      fromToken: collateralAsset,
      toToken: WFLOW,
      fromAmount: collateralAmount.toString(),
      fromAddress: contractAddress,
      toAddress: contractAddress, // Output stays in contract to repay
      apiKey,
      slippage
    });

    // Second swap is empty - reward is already in WFLOW
    const sParamToSendToReceiver = buildEmptySwapParams();

    // Override amountOutMin to ensure we get enough to repay flash loan + premium
    sParamToRepayLoan.amountOutMin = totalNeeded.toString();

    // Estimate reward for simple case
    const expectedOutput = BigNumber.from(quote.expectedOutput);
    const estimatedReward = expectedOutput.sub(totalNeeded);

    // Calculate swap cost (difference between input and output in USD)
    const swapCostUsd = parseFloat(quote.fromAmountUSD || 0) - parseFloat(quote.toAmountUSD || 0);

    return {
      sParamToRepayLoan,
      sParamToSendToReceiver,
      quote1: quote,
      quote2: null,
      estimatedReward,
      swapCostUsd
    };

  } else {
    // COMPLEX CASE: 2 swaps needed
    console.log('[Liquidation] Complex case: debtAsset is NOT WFLOW, 2 swaps needed');

    // Swap #1: collateral -> debtAsset (to repay flash loan)
    // toAddress = contractAddress (tokens stay in contract)
    const { swapParams: sParamToRepayLoan, quote: quote1 } = await buildSwapParams({
      fromToken: collateralAsset,
      toToken: debtAsset,
      fromAmount: collateralAmount.toString(),
      fromAddress: contractAddress,
      toAddress: contractAddress, // Stay in contract for repayment
      apiKey,
      slippage
    });

    // Override amountOutMin to ensure we get enough to repay flash loan + premium
    sParamToRepayLoan.amountOutMin = totalNeeded.toString();

    // Estimate reward after first swap
    const expectedFirstSwapOutput = BigNumber.from(quote1.expectedOutput);
    const estimatedReward = expectedFirstSwapOutput.sub(totalNeeded);

    console.log(`[Liquidation] First swap output: ${expectedFirstSwapOutput.toString()}`);
    console.log(`[Liquidation] Total needed: ${totalNeeded.toString()}`);
    console.log(`[Liquidation] Estimated reward: ${estimatedReward.toString()}`);

    if (estimatedReward.lte(0)) {
      throw new Error(`Liquidation not profitable: reward ${estimatedReward.toString()} <= 0`);
    }

    // Swap #2: debtAsset -> WFLOW (convert reward)
    // CRITICAL: toAddress = receiverAddress (profit goes directly to receiver!)
    const { swapParams: sParamToSendToReceiver, quote: quote2 } = await buildSwapParams({
      fromToken: debtAsset,
      toToken: WFLOW,
      fromAmount: estimatedReward.toString(),
      fromAddress: contractAddress,
      toAddress: receiverAddress, // CRITICAL: Profit goes to receiver!
      apiKey,
      slippage
    });

    // Override amountIn to 0 - contract calculates actual reward on-chain
    sParamToSendToReceiver.amountIn = 0;
    sParamToSendToReceiver.amountOutMin = 0;

    // Calculate swap costs (both swaps)
    const swapCostUsd = (parseFloat(quote1.fromAmountUSD || 0) - parseFloat(quote1.toAmountUSD || 0)) +
                        (parseFloat(quote2.fromAmountUSD || 0) - parseFloat(quote2.toAmountUSD || 0));

    return {
      sParamToRepayLoan,
      sParamToSendToReceiver,
      quote1,
      quote2,
      estimatedReward,
      swapCostUsd
    };
  }
}

async function main() {
  // 0. Pre-warm price cache with WFLOW
  try {
    await batchGetPrices([WFLOW]);
    console.log(`[Cache] Pre-warmed WFLOW price`);
  } catch (err) {
    console.log(`[Cache] Pre-warm failed (non-critical): ${err.message}`);
  }

  // 1. Fetch users from subgraph
  let allUsers = [];
  let skip = 0;
  const first = 100;
  let fetchNext = true;

  while (fetchNext) {
    const query = {
      query: usersQuery,
      variables: { first, skip },
    };
    const accountsInfo = await apolloFetcher(query);
    const fetchedUsers = accountsInfo?.data?.users || [];
    allUsers = allUsers.concat(fetchedUsers);

    if (fetchedUsers.length < first) {
      fetchNext = false;
    } else {
      skip += first;
    }
    console.log(`Fetched ${fetchedUsers.length} users, total: ${allUsers.length}`);
  }
  const users = allUsers;

  // 2. Check health factors via multicall
  let usersHealthReq = [];
  const userChunkSize = 50;
  let allUsersHealthRes = [];

  for (let poolInd = 0; poolInd < config.pools.length; poolInd++) {
    const pool = config.pools[poolInd];
    for (let i = 0; i < users.length; i += userChunkSize) {
      const userChunk = users.slice(i, i + userChunkSize);
      usersHealthReq = [];

      userChunk.map((user) => {
        usersHealthReq.push({
          target: pool,
          callData: poolInterface.encodeFunctionData("getUserAccountData", [
            user.id,
          ]),
        });
      });

      if (usersHealthReq.length > 0) {
        const chunkHealthRes = await retryWithBackoff(
          () => multicallContract.callStatic.aggregate(usersHealthReq),
          3, 1000, 'multicall-health'
        );

        const userWithHealth = chunkHealthRes.returnData.map((userHealth, ind) => {
          const detailedInfo = poolInterface.decodeFunctionResult(
            "getUserAccountData",
            userHealth
          );
          const userId = users[ind + i].id;
          return {
            pool: pool,
            block: chunkHealthRes.blockNumber,
            user: userId,
            healthFactor: BigNumber.from(detailedInfo.healthFactor),
            totalDebtBase: BigNumber.from(detailedInfo.totalDebtBase),
          };
        });

        allUsersHealthRes = allUsersHealthRes.concat(userWithHealth);
        console.log(`Pool ${pool}: processed ${userChunk.length} users`);
      }
    }
  }

  // 3. Filter unhealthy users (HF < 1) - SORTED BY DEBT SIZE (biggest first)
  const unhealthyUsers = allUsersHealthRes.filter(
    (userHealth) =>
      userHealth.healthFactor.lte(constants.WeiPerEther) && userHealth.healthFactor.gt(0)
  ).sort((a, b) => {
    // Sort by debt descending (biggest positions first = more profit)
    const debtA = Number(a.totalDebtBase.toString());
    const debtB = Number(b.totalDebtBase.toString());
    return debtB - debtA;
  });

  // Filter users close to liquidation (1.0 <= HF < 1.10) - NON-DUST only
  // Sorted by PRIORITY SCORE: debt * (1/HF) - bigger debt + lower HF = higher priority
  const wideUnhealthyUsers = allUsersHealthRes.filter((userHealth) => {
    if (!userHealth.healthFactor.lt(constants.WeiPerEther.mul(110).div(100))) return false; // HF < 1.10
    if (!userHealth.healthFactor.gte(constants.WeiPerEther)) return false; // HF >= 1.0
    // Filter dust using totalDebtBase (already in USD with 8 decimals)
    const debtUsd = Number(userHealth.totalDebtBase.toString()) / 1e8;
    return debtUsd >= MIN_DEBT_USD;
  }).sort((a, b) => {
    // Priority score: debt * (1/HF) - rewards big positions close to liquidation
    const debtA = Number(a.totalDebtBase.toString());
    const debtB = Number(b.totalDebtBase.toString());
    const hfA = Number(a.healthFactor.toString()) / 1e18;
    const hfB = Number(b.healthFactor.toString()) / 1e18;
    const priorityA = debtA / hfA;
    const priorityB = debtB / hfB;
    return priorityB - priorityA; // Higher priority first
  });

  // Update hot positions tracker with trigger prices
  for (const hotUser of wideUnhealthyUsers) {
    const hfFloat = Number(hotUser.healthFactor.toString()) / 1e18;
    const debtUsd = Number(hotUser.totalDebtBase.toString()) / 1e8;
    const priceDropPct = calculatePriceDropToLiquidate(hotUser.healthFactor);

    hotPositions.set(hotUser.user, {
      hf: hfFloat,
      debtUsd,
      priceDropToLiquidate: priceDropPct.toFixed(2),
      lastUpdate: Date.now()
    });
  }

  // Clean old entries from hotPositions (not seen in last 5 minutes)
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [user, data] of hotPositions.entries()) {
    if (data.lastUpdate < fiveMinutesAgo) {
      hotPositions.delete(user);
    }
  }

  console.log(`[HotPositions] Tracking ${hotPositions.size} positions near liquidation`);

  // Track actual liquidatable (non-dust) count
  let actualLiquidatable = 0;

  console.log(`Checking ${unhealthyUsers.length} potentially liquidatable users...`);
  console.log(`${wideUnhealthyUsers.length} users close to liquidation (HF < 1.05)`);

  // 5. Execute liquidations (use txProvider for sending transactions)
  const liquidator = new Wallet(config.liquidator_key, txProvider);

  for (const unhealthyUser of unhealthyUsers) {
    const botInfo = config.bots[unhealthyUser.pool];
    if (!botInfo) {
      console.log(`No bot config for pool ${unhealthyUser.pool}`);
      continue;
    }

    // Fetch user's token balances
    let mTokenRequest = [];
    botInfo.mTokens.map((mToken) => {
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [unhealthyUser.user]),
      });
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", []),
      });
    });

    botInfo.dTokens.map((dToken) => {
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("balanceOf", [unhealthyUser.user]),
      });
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData("UNDERLYING_ASSET_ADDRESS", []),
      });
    });

    const tokenRes = await retryWithBackoff(
      () => multicallContract.callStatic.aggregate(mTokenRequest),
      3, 1000, 'multicall-tokens'
    );

    let mInfos = [];
    let dInfos = [];
    let tokensWithUnderlying = [];

    const tokenInfos = tokenRes[1].map((tokenRes, ind) => ({
      info: mTokenInterface.decodeFunctionResult(
        ind % 2 == 0 ? "balanceOf" : "UNDERLYING_ASSET_ADDRESS",
        tokenRes
      ),
    }));

    for (let ii = 0; ii < tokenInfos.length; ii++) {
      const selInd = ii % 2;
      if (selInd == 0) {
        const detailedInfo = tokenInfos[ii].info[0];
        if (detailedInfo.gt(0)) {
          if (ii < botInfo.mTokens.length * 2) {
            mInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          } else {
            dInfos.push({
              token: tokenInfos[ii + 1].info,
              amount: BigNumber.from(detailedInfo),
            });
          }
        }
      } else if (ii < botInfo.mTokens.length * 2) {
        const detailedInfo = tokenInfos[ii].info[0].toLowerCase();
        const selInd = tokensWithUnderlying.findIndex(
          (tokenItem) => tokenItem.token == detailedInfo
        );
        if (selInd < 0) {
          tokensWithUnderlying.push({
            token: detailedInfo,
            mtoken: botInfo.mTokens[Math.floor(ii / 2)],
          });
        }
      }
    }

    // Skip if no collateral or debt
    if (mInfos.length === 0 || dInfos.length === 0) {
      console.log(`No collateral or debt for user ${unhealthyUser.user}`);
      await sendAlert(`⏭️ Skipped <a href="${FLOWSCAN_URL}/address/${unhealthyUser.user}">${shortAddr(unhealthyUser.user)}</a> - no collateral/debt`);
      continue;
    }

    const debtAsset = dInfos[0].token[0];

    const debtMToken = tokensWithUnderlying.find(
      (uToken) => uToken.token == debtAsset.toLowerCase()
    );

    if (!debtMToken) {
      console.log(`Debt token ${debtAsset} not found in mTokens`);
      continue;
    }

    // Get available debt in mToken
    const debtContract = new Contract(debtAsset, MTokenAbi, provider);
    const debtBalanceInmToken = await debtContract.balanceOf(debtMToken.mtoken);
    const userDebt = dInfos[0].amount;

    // Cap debt to available AND apply close factor (50% max liquidation)
    // Aave only allows liquidating up to 50% of user's debt in a single transaction
    const CLOSE_FACTOR = 50n; // 50%
    const maxLiquidatable = userDebt.mul(CLOSE_FACTOR).div(100n);
    let debtToCover = userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : userDebt;
    debtToCover = debtToCover.gt(maxLiquidatable) ? maxLiquidatable : debtToCover;

    // Add 0.1% buffer for interest accrual between read and execution
    // This prevents "ERC20InsufficientBalance" errors due to race conditions
    const INTEREST_BUFFER_BPS = 10n; // 0.1%
    debtToCover = debtToCover.mul(10000n + INTEREST_BUFFER_BPS).div(10000n);

    const debtDecimals = await debtContract.decimals();

    console.log(`[Liquidation] User debt: ${userDebt.toString()}`);
    console.log(`[Liquidation] Max liquidatable (50%): ${maxLiquidatable.toString()}`);
    console.log(`[Liquidation] Debt to cover (with buffer): ${debtToCover.toString()}`);

    if (debtToCover.lte(0)) {
      console.log(`No debt to cover for user ${unhealthyUser.user}`);
      continue;
    }

    // Skip dust positions using totalDebtBase (already in USD with 8 decimals)
    const debtValueUsd = Number(unhealthyUser.totalDebtBase.toString()) / 1e8;

    if (debtValueUsd < MIN_DEBT_USD) {
      console.log(`Skipping dust: ${shortAddr(unhealthyUser.user)} ($${debtValueUsd.toFixed(2)})`);
      continue;
    }

    // Skip positions that have repeatedly failed
    if (shouldSkipPosition(unhealthyUser.user)) {
      const failed = failedPositions.get(unhealthyUser.user);
      console.log(`⏭️  SKIPPING blacklisted position: ${shortAddr(unhealthyUser.user)} (${failed.failures} failures: ${failed.reason})`);
      continue;
    }

    // Count actual liquidatable (non-dust)
    actualLiquidatable++;

    // Only notify after passing dust filter
    const hf = (unhealthyUser.healthFactor.toString() / 1e18).toFixed(4);
    await sendAlert(`🎯 <b>Liquidation Target</b>\n\nUser: <a href="${FLOWSCAN_URL}/address/${unhealthyUser.user}">${shortAddr(unhealthyUser.user)}</a>\nHF: <b>${hf}</b>\nDebt: <b>$${debtValueUsd.toFixed(2)}</b>\nCollaterals: <b>${mInfos.length}</b>`);

    const contractAddress = botInfo.bot;
    let realRewardUsd = 0;

    try {
      console.log(`[Liquidation] User: ${unhealthyUser.user}`);
      console.log(`[Liquidation] Debt: ${debtAsset}`);
      console.log(`[Liquidation] Debt to cover: ${debtToCover.toString()}`);
      console.log(`[Liquidation] Available collaterals: ${mInfos.length}`);

      // Re-check health factor before liquidation (it may have changed)
      const poolContract = new Contract(unhealthyUser.pool, PoolAbi, provider);
      const freshData = await poolContract.getUserAccountData(unhealthyUser.user);
      const freshHF = BigNumber.from(freshData.healthFactor);
      console.log(`[Liquidation] Fresh HF: ${(Number(freshHF.toString()) / 1e18).toFixed(6)}`);

      if (freshHF.gt(constants.WeiPerEther)) {
        console.log(`[Liquidation] User no longer liquidatable (HF > 1), skipping`);
        await sendInfo(`⏭️ Skipped ${shortAddr(unhealthyUser.user)} - HF recovered to ${(Number(freshHF.toString()) / 1e18).toFixed(4)}`);
        continue;
      }

      const botContract = new Contract(contractAddress, LiquidationAbi, provider);

      // Try each collateral the user has
      let txReceipt = null;
      let tx = null;
      let lastError = null;
      let successCollateral = null;
      let sParamToRepayLoan, sParamToSendToReceiver, quote1, quote2, estimatedReward;
      let collateralDecimals;
      let usedStrategy = null;

      // ============================================
      // SMART STRATEGY SELECTION
      // Prioridad: V2 FlashSwap > V3 Flash > Eisen
      // ============================================

      // Calcular slippage dinámico basado en tamaño de posición
      const dynamicSlippage = calculateDynamicSlippage(debtValueUsd);
      const SLIPPAGE_LEVELS = [dynamicSlippage, dynamicSlippage * 1.5, dynamicSlippage * 2.5];

      // Calcular gas multiplier dinámico basado en profit esperado (~5% del debt)
      const expectedProfitUsd = debtValueUsd * 0.05;
      const gasMultiplier = calculateGasMultiplier(expectedProfitUsd);
      console.log(`[Strategy] Dynamic slippage for $${debtValueUsd.toFixed(0)}: ${(dynamicSlippage * 100).toFixed(1)}%, gas: ${gasMultiplier/100}x (profit ~$${expectedProfitUsd.toFixed(2)})`);

      // Seleccionar mejor estrategia para el debt token
      const strategyResult = await selectBestStrategy(
        mInfos[0].token[0], // Primer colateral como referencia
        debtAsset,
        debtToCover,
        BigNumber.from(0), // Se calcula después
        provider
      );

      console.log(`[Strategy] Selected: ${strategyResult.strategy} - ${strategyResult.reason}`);

      // Si hay poca liquidez, ajustar cantidad a liquidar
      let adjustedDebtToCover = debtToCover;
      if (strategyResult.maxAmount && strategyResult.maxAmount.lt(debtToCover)) {
        adjustedDebtToCover = strategyResult.maxAmount;
        console.log(`[Strategy] Reduciendo liquidación por liquidez: ${debtToCover.toString()} -> ${adjustedDebtToCover.toString()}`);

        // Verificar que aún sea rentable (mínimo $1 de ganancia esperada)
        const reducedDebtUsd = Number(adjustedDebtToCover.toString()) / Math.pow(10, debtDecimals);
        const expectedBonus = reducedDebtUsd * 0.05; // 5% liquidation bonus
        if (expectedBonus < 1) {
          console.log(`[Strategy] Liquidación parcial no rentable (bonus ~$${expectedBonus.toFixed(2)}), intentando Eisen`);
          strategyResult.strategy = Strategy.EISEN_FLASH_LOAN;
        }
      }

      // Loop through all collaterals
      for (let colIdx = 0; colIdx < mInfos.length && !txReceipt; colIdx++) {
        const collateralAsset = mInfos[colIdx].token[0];
        console.log(`\n[Collateral ${colIdx + 1}/${mInfos.length}] Trying: ${shortAddr(collateralAsset)}`);

        // Get decimals for this collateral
        const collateralContract = new Contract(collateralAsset, MTokenAbi, provider);
        collateralDecimals = await collateralContract.decimals();

        // Usar la cantidad ajustada (puede ser menor si hay poca liquidez)
        const effectiveDebtToCover = adjustedDebtToCover;

        // ============================================
        // STRATEGY 0: STABLEKITTY + MORE FLASH LOAN
        // Best for stable↔stable swaps (0.01% fee, low slippage)
        // ============================================
        if (!txReceipt && isStableSwap(collateralAsset, debtAsset)) {
          const stablePool = findStableKittyPool(collateralAsset, debtAsset);

          if (stablePool) {
            console.log(`[StableKitty] Stable↔Stable detected: ${stablePool.name}`);

            const flashLoanPremium = effectiveDebtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
            const totalNeeded = effectiveDebtToCover.add(flashLoanPremium);

            const expectedCollateral = await calculateExpectedCollateral(
              totalNeeded,
              collateralAsset,
              debtAsset,
              collateralDecimals,
              debtDecimals
            );

            // Get StableKitty quote
            const stableQuote = await getStableKittyQuote(stablePool, expectedCollateral);

            if (stableQuote && stableQuote.gte(totalNeeded)) {
              const minOutput = totalNeeded; // We need at least this much to repay

              try {
                console.log(`[StableKitty] Quote: ${expectedCollateral.toString()} col → ${stableQuote.toString()} debt`);

                sParamToRepayLoan = buildStableKittySwapParams(
                  stablePool,
                  expectedCollateral,
                  minOutput,
                  contractAddress
                );
                sParamToSendToReceiver = buildEmptySwapParamsLocal();
                estimatedReward = stableQuote.sub(totalNeeded);

                const lParam = {
                  collateralAsset,
                  debtAsset,
                  user: unhealthyUser.user,
                  amount: effectiveDebtToCover,
                  transferAmount: 0,
                  debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
                };

                // Simulate
                await botContract.callStatic.execute(
                  lParam,
                  sParamToRepayLoan,
                  sParamToSendToReceiver,
                  liquidator.address,
                  { from: liquidator.address }
                );
                console.log('[StableKitty Simulation] OK - proceeding with tx');

                const gasPrice = await provider.getGasPrice();
                const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

                // Execute
                tx = await botContract
                  .connect(liquidator)
                  .execute(
                    lParam,
                    sParamToRepayLoan,
                    sParamToSendToReceiver,
                    liquidator.address,
                    { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                  );

                console.log(`[StableKitty TX] Sent: ${tx.hash}`);
                txReceipt = await tx.wait();

                if (txReceipt.status === 1) {
                  console.log(`[StableKitty TX] SUCCESS!`);
                  successCollateral = collateralAsset;
                  usedStrategy = 'STABLEKITTY_MORE';
                } else {
                  throw new Error('Transaction reverted');
                }

              } catch (err) {
                const reason = err?.error?.reason || err?.reason || err?.message || 'Unknown';
                console.log(`[StableKitty+MORE] Failed: ${reason.slice(0, 80)}`);
                lastError = err;

                // Try StableKitty + V3 Flash if MORE failed
                const v3Pool = strategyResult.strategy === Strategy.V3_FLASH
                  ? strategyResult.pool
                  : strategyResult.alternatives?.find(a => a.strategy === Strategy.V3_FLASH)?.pool;

                if (v3Pool && !txReceipt) {
                  try {
                    console.log(`[StableKitty+V3] Trying V3 flash source...`);

                    await botContract.callStatic.executeFlashV3(
                      v3Pool,
                      lParam,
                      sParamToRepayLoan,
                      sParamToSendToReceiver,
                      liquidator.address,
                      { from: liquidator.address }
                    );
                    console.log('[StableKitty+V3 Simulation] OK');

                    const gasPrice = await provider.getGasPrice();
                    const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

                    tx = await botContract
                      .connect(liquidator)
                      .executeFlashV3(
                        v3Pool,
                        lParam,
                        sParamToRepayLoan,
                        sParamToSendToReceiver,
                        liquidator.address,
                        { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                      );

                    console.log(`[StableKitty+V3 TX] Sent: ${tx.hash}`);
                    txReceipt = await tx.wait();

                    if (txReceipt.status === 1) {
                      console.log(`[StableKitty+V3 TX] SUCCESS!`);
                      successCollateral = collateralAsset;
                      usedStrategy = 'STABLEKITTY_V3';
                    }
                  } catch (v3Err) {
                    console.log(`[StableKitty+V3] Failed: ${(v3Err?.message || '').slice(0, 60)}`);
                  }
                }
              }
            } else {
              console.log(`[StableKitty] Quote insufficient, falling back...`);
            }
          } else {
            console.log(`[StableKitty] No pool for ${shortAddr(collateralAsset)}→${shortAddr(debtAsset)}`);
          }
        }

        // ============================================
        // STRATEGY 1: V2 FlashSwap (PunchSwap)
        // Más simple, sin dependencia de API externa
        // Fee: 0.3%
        // ============================================
        if ((strategyResult.strategy === Strategy.V2_FLASH_SWAP || !txReceipt) && strategyResult.pool) {
          const flashSwapFee = effectiveDebtToCover.mul(FLASH_SWAP_FEE_BPS).div(10000n);
          const totalNeededFlashSwap = effectiveDebtToCover.add(flashSwapFee);

          const expectedCollateral = await calculateExpectedCollateral(
            totalNeededFlashSwap,
            collateralAsset,
            debtAsset,
            collateralDecimals,
            debtDecimals
          );

          for (const slippage of SLIPPAGE_LEVELS) {
            try {
              console.log(`[V2 FlashSwap] Collateral ${colIdx + 1}, Slippage ${(slippage * 100).toFixed(1)}%...`);

              // Build Flash Swap params (PunchSwap V2)
              const params = await buildFlashSwapLiquidationParams({
                collateralAsset,
                debtAsset,
                debtAmount: effectiveDebtToCover,
                collateralAmount: expectedCollateral,
                router: PUNCHSWAP_ROUTER,
                wflow: WFLOW,
                slippage,
                provider
              });

              sParamToRepayLoan = params.sParamToRepayLoan;
              sParamToSendToReceiver = params.sParamToSendToReceiver;
              quote1 = params.quote1;
              quote2 = params.quote2;
              estimatedReward = params.estimatedReward;

              realRewardUsd = Number(estimatedReward.toString()) / Math.pow(10, debtDecimals);

              const lParam = {
                collateralAsset,
                debtAsset,
                user: unhealthyUser.user,
                amount: effectiveDebtToCover,
                transferAmount: 0,
                debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
              };

              // Simulate Flash Swap
              await botContract.callStatic.executeFlashSwap(
                strategyResult.pool,
                lParam,
                sParamToRepayLoan,
                sParamToSendToReceiver,
                liquidator.address,
                { from: liquidator.address }
              );
              console.log('[V2 FlashSwap Simulation] OK - proceeding with tx');

              const gasPrice = await provider.getGasPrice();
              const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

              // Execute Flash Swap
              tx = await botContract
                .connect(liquidator)
                .executeFlashSwap(
                  strategyResult.pool,
                  lParam,
                  sParamToRepayLoan,
                  sParamToSendToReceiver,
                  liquidator.address,
                  { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                );

              console.log(`[V2 FlashSwap TX] Sent: ${tx.hash}`);
              txReceipt = await tx.wait();

              if (txReceipt.status === 1) {
                console.log(`[V2 FlashSwap TX] SUCCESS! Collateral: ${shortAddr(collateralAsset)}, Slippage: ${(slippage * 100).toFixed(1)}%`);
                successCollateral = collateralAsset;
                usedStrategy = 'V2_FLASH_SWAP';
                break;
              } else {
                throw new Error('Transaction reverted');
              }

            } catch (err) {
              const reason = err?.error?.reason || err?.errorName || err?.reason || err?.message || 'Unknown';
              console.log(`[V2 FlashSwap] Failed: ${reason}`);
              lastError = err;

              const isSwapError = reason.includes('SwapFailed') || reason.includes('NoReward') || reason.includes('not profitable');
              if (!isSwapError) {
                console.log(`[V2 FlashSwap] Non-swap error for this collateral, continuing...`);
                // Don't break - let it try other strategies for this collateral
              }
            }
          }
        }

        // ============================================
        // STRATEGY 2: V3 Flash (FlowSwap) - SEGUNDA OPCIÓN
        // Mejor para ankrFLOW (0.01% fee)
        // ============================================
        if (!txReceipt && (strategyResult.strategy === Strategy.V3_FLASH || strategyResult.alternatives?.some(a => a.strategy === Strategy.V3_FLASH))) {
          const v3Pool = strategyResult.strategy === Strategy.V3_FLASH
            ? strategyResult.pool
            : strategyResult.alternatives?.find(a => a.strategy === Strategy.V3_FLASH)?.pool;

          if (v3Pool) {
            // V3 fee varies by pool (100 = 0.01%, 3000 = 0.3%)
            const v3Fee = strategyResult.fee || 30; // Default 0.3%
            const flashFee = effectiveDebtToCover.mul(BigInt(v3Fee)).div(10000n);
            const totalNeededV3 = effectiveDebtToCover.add(flashFee);

            const expectedCollateral = await calculateExpectedCollateral(
              totalNeededV3,
              collateralAsset,
              debtAsset,
              collateralDecimals,
              debtDecimals
            );

            for (const slippage of SLIPPAGE_LEVELS) {
              try {
                console.log(`[V3 Flash] Collateral ${colIdx + 1}, Slippage ${(slippage * 100).toFixed(1)}%, Fee ${v3Fee/100}%...`);

                // Build swap params for V3 flash
                const params = await buildFlashSwapLiquidationParams({
                  collateralAsset,
                  debtAsset,
                  debtAmount: effectiveDebtToCover,
                  collateralAmount: expectedCollateral,
                  router: PUNCHSWAP_ROUTER,
                  wflow: WFLOW,
                  slippage,
                  provider
                });

                sParamToRepayLoan = params.sParamToRepayLoan;
                sParamToSendToReceiver = params.sParamToSendToReceiver;
                estimatedReward = params.estimatedReward;

                realRewardUsd = Number(estimatedReward.toString()) / Math.pow(10, debtDecimals);

                const lParam = {
                  collateralAsset,
                  debtAsset,
                  user: unhealthyUser.user,
                  amount: effectiveDebtToCover,
                  transferAmount: 0,
                  debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
                };

                // Simulate V3 Flash
                await botContract.callStatic.executeFlashV3(
                  v3Pool,
                  lParam,
                  sParamToRepayLoan,
                  sParamToSendToReceiver,
                  liquidator.address,
                  { from: liquidator.address }
                );
                console.log('[V3 Flash Simulation] OK - proceeding with tx');

                const gasPrice = await provider.getGasPrice();
                const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

                // Execute V3 Flash
                tx = await botContract
                  .connect(liquidator)
                  .executeFlashV3(
                    v3Pool,
                    lParam,
                    sParamToRepayLoan,
                    sParamToSendToReceiver,
                    liquidator.address,
                    { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                  );

                console.log(`[V3 Flash TX] Sent: ${tx.hash}`);
                txReceipt = await tx.wait();

                if (txReceipt.status === 1) {
                  console.log(`[V3 Flash TX] SUCCESS! Collateral: ${shortAddr(collateralAsset)}, Slippage: ${(slippage * 100).toFixed(1)}%`);
                  successCollateral = collateralAsset;
                  usedStrategy = 'V3_FLASH';
                  break;
                } else {
                  throw new Error('Transaction reverted');
                }

              } catch (err) {
                const reason = err?.error?.reason || err?.errorName || err?.reason || err?.message || 'Unknown';
                console.log(`[V3 Flash] Failed: ${reason}`);
                lastError = err;

                const isSwapError = reason.includes('SwapFailed') || reason.includes('NoReward') || reason.includes('not profitable');
                if (!isSwapError) {
                  console.log(`[V3 Flash] Non-swap error for this collateral, trying Eisen...`);
                  // Continue to try Eisen for this collateral
                }
              }
            }
          }
        }

        // ============================================
        // STRATEGY 3: Aave Flash Loan + V2 Swap Directo
        // Sin API externa, usa quotes locales
        // Fee: 0.05% + 0.3% swap
        // ============================================
        if (!txReceipt) {
          const flashLoanPremium = effectiveDebtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
          const totalNeeded = effectiveDebtToCover.add(flashLoanPremium);

          if (colIdx === 0) {
            console.log(`[V2 Direct] Aave Flash + V2 Swap (no Eisen)`);
            console.log(`[V2 Direct] Total needed: ${totalNeeded.toString()}`);
          }

          const expectedCollateral = await calculateExpectedCollateral(
            totalNeeded,
            collateralAsset,
            debtAsset,
            collateralDecimals,
            debtDecimals
          );

          for (const slippage of SLIPPAGE_LEVELS) {
            try {
              console.log(`[V2 Direct] Collateral ${colIdx + 1}, Slippage ${(slippage * 100).toFixed(1)}%...`);

              // Build V2 swap params locally (no API call)
              const slippageBps = BigInt(Math.floor(slippage * 10000));
              const minOutput = totalNeeded.mul(10000n - slippageBps).div(10000n);

              sParamToRepayLoan = buildV2SwapParamsLocal(
                collateralAsset,
                debtAsset,
                expectedCollateral,
                minOutput,
                PUNCHSWAP_ROUTER
              );
              sParamToSendToReceiver = buildEmptySwapParamsLocal();
              estimatedReward = expectedCollateral.mul(5n).div(100n); // ~5% estimate

              const lParam = {
                collateralAsset,
                debtAsset,
                user: unhealthyUser.user,
                amount: effectiveDebtToCover,
                transferAmount: 0,
                debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
              };

              // Simulate
              await botContract.callStatic.execute(
                lParam,
                sParamToRepayLoan,
                sParamToSendToReceiver,
                liquidator.address,
                { from: liquidator.address }
              );
              console.log('[V2 Direct Simulation] OK - proceeding with tx');

              const gasPrice = await provider.getGasPrice();
              const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

              // Execute
              tx = await botContract
                .connect(liquidator)
                .execute(
                  lParam,
                  sParamToRepayLoan,
                  sParamToSendToReceiver,
                  liquidator.address,
                  { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                );

              console.log(`[V2 Direct TX] Sent: ${tx.hash}`);
              txReceipt = await tx.wait();

              if (txReceipt.status === 1) {
                console.log(`[V2 Direct TX] SUCCESS!`);
                successCollateral = collateralAsset;
                usedStrategy = 'V2_DIRECT_FLASH';
                break;
              } else {
                throw new Error('Transaction reverted');
              }

            } catch (err) {
              const reason = err?.error?.reason || err?.errorName || err?.reason || err?.message || 'Unknown';
              console.log(`[V2 Direct+MORE] Failed: ${reason.slice(0, 80)}`);
              lastError = err;
            }
          }

          // Try V3 flash source if MORE failed
          if (!txReceipt) {
            const v3Pool = strategyResult.strategy === Strategy.V3_FLASH
              ? strategyResult.pool
              : strategyResult.alternatives?.find(a => a.strategy === Strategy.V3_FLASH)?.pool;

            if (v3Pool) {
              for (const slippage of SLIPPAGE_LEVELS) {
                try {
                  console.log(`[V2 Direct+V3] Trying V3 flash source, Slippage ${(slippage * 100).toFixed(1)}%...`);

                  const slippageBps = BigInt(Math.floor(slippage * 10000));
                  const minOutput = totalNeeded.mul(10000n - slippageBps).div(10000n);

                  sParamToRepayLoan = buildV2SwapParamsLocal(
                    collateralAsset,
                    debtAsset,
                    expectedCollateral,
                    minOutput,
                    PUNCHSWAP_ROUTER
                  );
                  sParamToSendToReceiver = buildEmptySwapParamsLocal();

                  const lParam = {
                    collateralAsset,
                    debtAsset,
                    user: unhealthyUser.user,
                    amount: effectiveDebtToCover,
                    transferAmount: 0,
                    debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
                  };

                  await botContract.callStatic.executeFlashV3(
                    v3Pool,
                    lParam,
                    sParamToRepayLoan,
                    sParamToSendToReceiver,
                    liquidator.address,
                    { from: liquidator.address }
                  );
                  console.log('[V2 Direct+V3 Simulation] OK');

                  const gasPrice = await provider.getGasPrice();
                  const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

                  tx = await botContract
                    .connect(liquidator)
                    .executeFlashV3(
                      v3Pool,
                      lParam,
                      sParamToRepayLoan,
                      sParamToSendToReceiver,
                      liquidator.address,
                      { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                    );

                  console.log(`[V2 Direct+V3 TX] Sent: ${tx.hash}`);
                  txReceipt = await tx.wait();

                  if (txReceipt.status === 1) {
                    console.log(`[V2 Direct+V3 TX] SUCCESS!`);
                    successCollateral = collateralAsset;
                    usedStrategy = 'V3_DIRECT_FLASH';
                    break;
                  }
                } catch (v3Err) {
                  console.log(`[V2 Direct+V3] Failed: ${(v3Err?.message || '').slice(0, 60)}`);
                }
              }
            }
          }
        }

        // ============================================
        // STRATEGY 5: Eisen API (FALLBACK FINAL)
        // Solo si todo lo anterior falla
        // ============================================
        if (!txReceipt && config.eisen_api_key) {
          console.log(`[Eisen] Fallback - trying Eisen API...`);

          const flashLoanPremium = effectiveDebtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
          const totalNeeded = effectiveDebtToCover.add(flashLoanPremium);

          const expectedCollateral = await calculateExpectedCollateral(
            totalNeeded,
            collateralAsset,
            debtAsset,
            collateralDecimals,
            debtDecimals
          );

          for (const slippage of SLIPPAGE_LEVELS) {
            try {
              console.log(`[Eisen] Collateral ${colIdx + 1}, Slippage ${(slippage * 100).toFixed(1)}%...`);

              // Build Flash Loan params (Eisen API)
              const params = await buildLiquidationParams({
                collateralAsset,
                debtAsset,
                totalNeeded,
                collateralAmount: expectedCollateral,
                contractAddress,
                receiverAddress: liquidator.address,
                apiKey: config.eisen_api_key,
                slippage
              });

              sParamToRepayLoan = params.sParamToRepayLoan;
              sParamToSendToReceiver = params.sParamToSendToReceiver;
              quote1 = params.quote1;
              quote2 = params.quote2;
              estimatedReward = params.estimatedReward;

              const lParam = {
                collateralAsset,
                debtAsset,
                user: unhealthyUser.user,
                amount: effectiveDebtToCover,
                transferAmount: 0,
                debtToCover: userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : constants.MaxUint256,
              };

              // Simulate
              await botContract.callStatic.execute(
                lParam,
                sParamToRepayLoan,
                sParamToSendToReceiver,
                liquidator.address,
                { from: liquidator.address }
              );
              console.log('[Eisen Simulation] OK - proceeding with tx');

              const gasPrice = await provider.getGasPrice();
              const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

              // Execute
              tx = await botContract
                .connect(liquidator)
                .execute(
                  lParam,
                  sParamToRepayLoan,
                  sParamToSendToReceiver,
                  liquidator.address,
                  { gasLimit: 4000000, gasPrice: adjustedGasPrice }
                );

              console.log(`[Eisen TX] Sent: ${tx.hash}`);
              txReceipt = await tx.wait();

              if (txReceipt.status === 1) {
                console.log(`[Eisen TX] SUCCESS!`);
                successCollateral = collateralAsset;
                usedStrategy = 'EISEN_FLASH_LOAN';
                break;
              } else {
                throw new Error('Transaction reverted');
              }

            } catch (err) {
              const reason = err?.error?.reason || err?.errorName || err?.reason || err?.message || 'Unknown';
              console.log(`[Eisen] Failed: ${reason.slice(0, 80)}`);
              lastError = err;
            }
          }
        }
      }

      // If we get here without txReceipt, all attempts failed
      if (!txReceipt) {
        throw lastError || new Error('All collaterals and slippage levels failed');
      }

      console.log(`[TX] Confirmed! Block: ${txReceipt.blockNumber}, Gas: ${txReceipt.gasUsed.toString()}`);

      // Calculate gas cost
      const gasUsed = txReceipt.gasUsed;
      const effectiveGasPrice = tx.gasPrice || txReceipt.effectiveGasPrice;
      const gasCostWei = gasUsed.mul(effectiveGasPrice);
      const gasCostFlow = Number(gasCostWei.toString()) / 1e18;

      // Get liquidator FLOW balance
      const liquidatorBalance = await provider.getBalance(liquidator.address);
      const liquidatorFlowBalance = Number(liquidatorBalance.toString()) / 1e18;

      // Get WFLOW balance (profit is in WFLOW)
      const wflowContract = new Contract(WFLOW, MTokenAbi, provider);
      const wflowBalance = await wflowContract.balanceOf(liquidator.address);
      const liquidatorWflowBalance = Number(wflowBalance.toString()) / 1e18;

      // Get collateral token symbol (use address if not available)
      const collateralSymbol = shortAddr(successCollateral);

      // Get FLOW price from cache (8 decimals)
      const flowPrice = await getCachedPrice(WFLOW);
      const flowPriceUsd = Number(flowPrice) / 1e8;
      const gasCostUsd = gasCostFlow * flowPriceUsd;

      // Calculate profit based on strategy type
      // - Eisen with 2 swaps: quote2.expectedOutput is in WFLOW (18 decimals)
      // - Eisen with 1 swap (debt=WFLOW): estimatedReward is in WFLOW (18 decimals)
      // - StableKitty: estimatedReward is in debt token (6 decimals for stables)
      // - V2/V3 Direct: estimatedReward is ~5% of collateral (estimate only)
      let rewardUsd, rewardDisplay;

      if (quote2) {
        // Eisen 2-swap: reward is in WFLOW
        const rewardWflow = Number(quote2.expectedOutput) / 1e18;
        rewardUsd = rewardWflow * flowPriceUsd;
        rewardDisplay = `~${rewardWflow.toFixed(4)} WFLOW (~$${rewardUsd.toFixed(2)})`;
      } else if (usedStrategy?.includes('STABLEKITTY')) {
        // StableKitty: reward is in debt token (stables = 6 decimals, ~$1 each)
        const rewardInDebt = Number(estimatedReward.toString()) / Math.pow(10, debtDecimals);
        rewardUsd = rewardInDebt; // Stables ≈ $1
        rewardDisplay = `~$${rewardUsd.toFixed(2)} (in debt token)`;
      } else if (usedStrategy?.includes('DIRECT')) {
        // V2/V3 Direct: estimatedReward is rough estimate in collateral
        // Use 5% of debt value as profit estimate (liquidation bonus)
        rewardUsd = debtValueUsd * 0.05;
        rewardDisplay = `~$${rewardUsd.toFixed(2)} (estimated 5% bonus)`;
      } else if (debtAsset.toLowerCase() === WFLOW.toLowerCase()) {
        // Eisen 1-swap where debt is WFLOW
        const rewardWflow = Number(estimatedReward.toString()) / 1e18;
        rewardUsd = rewardWflow * flowPriceUsd;
        rewardDisplay = `~${rewardWflow.toFixed(4)} WFLOW (~$${rewardUsd.toFixed(2)})`;
      } else {
        // Fallback: estimate from debt value
        rewardUsd = debtValueUsd * 0.05;
        rewardDisplay = `~$${rewardUsd.toFixed(2)} (estimated)`;
      }

      // Strategy emoji mapping
      const strategyEmoji = {
        'STABLEKITTY_MORE': '🐱 StableKitty+MORE',
        'STABLEKITTY_V3': '🐱 StableKitty+V3',
        'V2_FLASH_SWAP': '⚡ V2 FlashSwap',
        'V3_FLASH': '🔷 V3 Flash',
        'V2_DIRECT_FLASH': '💨 V2 Direct',
        'V3_DIRECT_FLASH': '💎 V3 Direct',
        'EISEN_FLASH_LOAN': '🌐 Eisen'
      };
      const methodUsed = strategyEmoji[usedStrategy] || '💳 FlashLoan';

      // Check if we did partial liquidation
      const wasPartial = adjustedDebtToCover.lt(debtToCover);
      const partialNote = wasPartial ? ' (partial)' : '';

      // Clear from blacklist on success
      clearFailedPosition(unhealthyUser.user);

      await sendAlert([
        `✅ <b>Liquidation Success!</b> ${methodUsed}${partialNote}`,
        ``,
        `👤 <a href="${FLOWSCAN_URL}/address/${unhealthyUser.user}">${shortAddr(unhealthyUser.user)}</a>`,
        `📊 HF: ${hf} → ~1.10`,
        ``,
        `💰 <b>Details:</b>`,
        `   Debt covered: ${(Number(adjustedDebtToCover.toString()) / Math.pow(10, debtDecimals)).toFixed(2)}${wasPartial ? ' (reduced)' : ' (50%)'}`,
        `   Collateral: ${collateralSymbol}`,
        ``,
        `📈 <b>Profit:</b>`,
        `   Reward: ${rewardDisplay}`,
        `   Gas: -${gasCostFlow.toFixed(4)} FLOW (~$${gasCostUsd.toFixed(2)})`,
        ``,
        `🏦 <b>Balance:</b> ${liquidatorFlowBalance.toFixed(2)} FLOW | ${liquidatorWflowBalance.toFixed(4)} WFLOW`,
        ``,
        `🔗 <a href="${FLOWSCAN_URL}/tx/${txReceipt.transactionHash}">Tx</a> | <a href="${FLOWSCAN_URL}/address/${liquidator.address}">Wallet</a>`
      ].join('\n'));

    } catch (err) {
      const revertReason = err?.error?.reason || err?.reason || err?.data || err.message;
      console.error("Liquidation failed:", revertReason);

      // Parse common error types for better messages with fix hints
      let errorMsg = String(revertReason).slice(0, 150);
      let fixHint = '';

      if (errorMsg.includes('ERC20InsufficientBalance')) {
        errorMsg = 'ERC20InsufficientBalance';
        fixHint = 'Fix: Increase INTEREST_BUFFER_BPS';
      } else if (errorMsg.includes('SwapFailed')) {
        errorMsg = 'SwapFailed';
        fixHint = 'Fix: Reduce CONSERVATIVE_FACTOR or check liquidity';
      } else if (errorMsg.includes('NoReward')) {
        errorMsg = 'NoReward';
        fixHint = 'Fix: Increase CONSERVATIVE_FACTOR or min_debt_usd';
      } else if (errorMsg.includes('not profitable')) {
        errorMsg = 'Not profitable';
        fixHint = 'Fix: Increase min_debt_usd to skip small positions';
      } else if (errorMsg.includes('gas')) {
        errorMsg = 'Gas error';
        fixHint = 'Fix: Check gas price multiplier';
      } else if (errorMsg.includes('processing response error')) {
        errorMsg = 'RPC processing error';
        fixHint = 'Fix: RPC node issue, retry or change RPC';
      } else if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
        errorMsg = 'RPC timeout';
        fixHint = 'Fix: RPC node slow, try different RPC';
      }

      // Calculate what we tried
      const debtCoveredUsd = (Number(debtToCover.toString()) / Math.pow(10, debtDecimals));
      const theoreticalBonus = debtCoveredUsd * 0.05;

      // Record failure if it's a swap/profitability error (blacklist systematic failures)
      const isSwapOrProfitError = errorMsg.includes('SwapFailed') ||
                                   errorMsg.includes('NoReward') ||
                                   errorMsg.includes('not profitable') ||
                                   realRewardUsd < 0; // Negative reward = bad swap economics

      if (isSwapOrProfitError) {
        recordFailedLiquidation(unhealthyUser.user, errorMsg);
        const failCount = failedPositions.get(unhealthyUser.user)?.failures || 0;
        if (failCount >= MAX_FAILURES_BEFORE_BLACKLIST) {
          console.log(`🚫 Position ${shortAddr(unhealthyUser.user)} BLACKLISTED after ${failCount} failures`);
        }
      }

      await sendAlert([
        `❌ <b>Liquidation Failed</b>`,
        ``,
        `👤 <a href="${FLOWSCAN_URL}/address/${unhealthyUser.user}">${shortAddr(unhealthyUser.user)}</a>`,
        `📊 HF: ${hf}`,
        ``,
        `💵 Attempted: ${debtCoveredUsd.toFixed(2)} debt (50%)`,
        `🎁 Theoretical bonus: ~$${theoreticalBonus.toFixed(2)}`,
        `💰 Est. profit: $${realRewardUsd.toFixed(2)}`,
        ``,
        `❗ <code>${errorMsg}</code>`,
        fixHint ? `💡 ${fixHint}` : ''
      ].filter(Boolean).join('\n'));
    }

    await sleep(5000);
  }

  // Send periodic status report (after processing)
  const state = loadState();
  if (shouldSendReport(state)) {
    // Calculate total debt at risk
    const totalDebtAtRisk = wideUnhealthyUsers.reduce((sum, u) => {
      return sum + Number(u.totalDebtBase.toString()) / 1e8;
    }, 0);

    // Get liquidator balances
    const liquidatorBalance = await provider.getBalance(liquidator.address);
    const liquidatorFlowBalance = Number(liquidatorBalance.toString()) / 1e18;
    const wflowContract = new Contract(WFLOW, MTokenAbi, provider);
    const wflowBalance = await wflowContract.balanceOf(liquidator.address);
    const liquidatorWflowBalance = Number(wflowBalance.toString()) / 1e18;

    const reportLines = [
      `📊 <b>Status Report</b>`,
      ``,
      `👥 Users monitored: <b>${allUsersHealthRes.length}</b>`,
      `🔴 Liquidatable: <b>${actualLiquidatable}</b>`,
      `🟡 Near liquidation: <b>${wideUnhealthyUsers.length}</b>`,
      `💰 Debt at risk: <b>$${totalDebtAtRisk.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>`,
    ];

    // Show top positions - both by proximity to liquidation AND by size
    if (wideUnhealthyUsers.length > 0) {
      // Top 3 closest to liquidation (sorted by HF ascending)
      reportLines.push(``, `<b>🎯 Closest to liquidation:</b>`);
      const topByHF = wideUnhealthyUsers.slice(0, 3);
      for (const u of topByHF) {
        const hf = (Number(u.healthFactor.toString()) / 1e18).toFixed(4);
        const debtUsd = (Number(u.totalDebtBase.toString()) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 });
        const priceDrop = calculatePriceDropToLiquidate(u.healthFactor).toFixed(2);
        reportLines.push(`• <a href="${FLOWSCAN_URL}/address/${u.user}">${shortAddr(u.user)}</a> HF: ${hf} ($${debtUsd}) -${priceDrop}%`);
      }

      // Top 3 biggest positions (sorted by debt descending)
      const topByDebt = [...wideUnhealthyUsers].sort((a, b) => {
        const debtA = Number(a.totalDebtBase.toString());
        const debtB = Number(b.totalDebtBase.toString());
        return debtB - debtA;
      }).slice(0, 3);

      // Only show if different from topByHF
      const topByHFUsers = new Set(topByHF.map(u => u.user));
      const uniqueByDebt = topByDebt.filter(u => !topByHFUsers.has(u.user));

      if (uniqueByDebt.length > 0) {
        reportLines.push(``, `<b>💰 Biggest positions:</b>`);
        for (const u of uniqueByDebt) {
          const hf = (Number(u.healthFactor.toString()) / 1e18).toFixed(4);
          const debtUsd = (Number(u.totalDebtBase.toString()) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 });
          const priceDrop = calculatePriceDropToLiquidate(u.healthFactor).toFixed(2);
          reportLines.push(`• <a href="${FLOWSCAN_URL}/address/${u.user}">${shortAddr(u.user)}</a> HF: ${hf} ($${debtUsd}) -${priceDrop}%`);
        }
      }
    }

    // Show liquidator balance
    reportLines.push(``, `🏦 <b>Liquidator:</b> <a href="${FLOWSCAN_URL}/address/${liquidator.address}">${shortAddr(liquidator.address)}</a>`);
    reportLines.push(`   FLOW: ${liquidatorFlowBalance.toFixed(4)} | WFLOW: ${liquidatorWflowBalance.toFixed(4)}`);

    // Show DEX liquidity (PunchSwap V2 + FlowSwap V3)
    try {
      const [punchLiquidity, v3Liquidity] = await Promise.all([
        getPunchSwapLiquidity(),
        getV3Liquidity()
      ]);

      // PunchSwap V2 (Flash Swap available)
      reportLines.push(``, `<b>⚡ PunchSwap V2:</b>`);
      for (const [name, info] of Object.entries(punchLiquidity)) {
        if (info.error) {
          reportLines.push(`• ${name}: ❌`);
        } else {
          const tvl = Number(info.tvlUsd).toLocaleString('en-US', { maximumFractionDigits: 0 });
          reportLines.push(`• ${name}: $${tvl}`);
        }
      }

      // FlowSwap V3 (routing only, no flash swap)
      reportLines.push(``, `<b>🔷 FlowSwap V3:</b>`);
      for (const [name, info] of Object.entries(v3Liquidity)) {
        if (info.error) {
          reportLines.push(`• ${name}: ❌`);
        } else {
          const tvl = Number(info.tvlUsd).toLocaleString('en-US', { maximumFractionDigits: 0 });
          reportLines.push(`• ${name}: $${tvl}`);
        }
      }
    } catch (err) {
      console.log(`[Report] Liquidity fetch error: ${err.message}`);
    }

    reportLines.push(``, `<i>Min debt: $${MIN_DEBT_USD}</i>`);

    await sendInfo(reportLines.join('\n'));
    state.lastReportTime = Date.now();
    saveState(state);
    console.log('Status report sent');
  }

  console.log(`Cycle complete. Liquidatable (non-dust): ${actualLiquidatable}`);
}

// AWS Lambda handler
exports.handler = async (event) => {
  console.log("Event received:", event);
  try {
    await main();
    return {
      statusCode: 200,
      body: JSON.stringify({ message: "OK" }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Error", error: error.message }),
    };
  }
};

// Quick check only hot positions (faster than full subgraph scan)
async function quickCheckHotPositions() {
  if (hotPositions.size === 0) return [];

  const hotUsers = Array.from(hotPositions.keys());
  const poolAddress = config.pools[0];
  const liquidatable = [];

  // Clean expired prepared params
  cleanExpiredPrepared();

  console.log(`[QuickCheck] Checking ${hotUsers.length} hot positions (${preparedLiquidations.size} prepared)...`);

  // Batch check health factors via multicall
  const requests = hotUsers.map(user => ({
    target: poolAddress,
    callData: poolInterface.encodeFunctionData("getUserAccountData", [user])
  }));

  try {
    const start = Date.now();
    const results = await retryWithBackoff(
      () => multicallContract.callStatic.aggregate(requests),
      3, 1000, 'multicall-quickcheck'
    );
    const elapsed = Date.now() - start;

    let lowestHF = Infinity;
    let lowestUser = null;
    const toPrepare = []; // Posiciones con HF < 1.05 que necesitan preparación

    results.returnData.forEach((data, idx) => {
      const decoded = poolInterface.decodeFunctionResult("getUserAccountData", data);
      const hf = BigNumber.from(decoded.healthFactor);
      const totalDebtBase = BigNumber.from(decoded.totalDebtBase);
      const user = hotUsers[idx];
      const hfFloat = Number(hf.toString()) / 1e18;
      const debtUsd = Number(totalDebtBase.toString()) / 1e8;

      if (hfFloat < lowestHF && hfFloat > 0) {
        lowestHF = hfFloat;
        lowestUser = user;
      }

      // Skip dust
      if (debtUsd < MIN_DEBT_USD) return;

      // Skip blacklisted positions
      if (shouldSkipPosition(user)) {
        const failed = failedPositions.get(user);
        console.log(`[QuickCheck] ⏭️  Skipping blacklisted: ${shortAddr(user)} HF: ${hfFloat.toFixed(4)} (${failed.failures} failures)`);
        return;
      }

      if (hf.lte(constants.WeiPerEther) && hf.gt(0)) {
        // LIQUIDATABLE NOW!
        const hotData = hotPositions.get(user);
        liquidatable.push({
          pool: poolAddress,
          user,
          healthFactor: hf,
          totalDebtBase,
          wasHot: true,
          previousHF: hotData?.hf,
          prepared: getPreparedParams(user) // Include prepared params if available
        });
        console.log(`[QuickCheck] 🔥 HOT position NOW LIQUIDATABLE: ${shortAddr(user)} HF: ${hfFloat.toFixed(4)}`);
      } else {
        // Update hot position data
        const hotData = hotPositions.get(user);
        if (hotData) {
          hotData.hf = hfFloat;
          hotData.priceDropToLiquidate = calculatePriceDropToLiquidate(hf).toFixed(2);
          hotData.lastUpdate = Date.now();
        }

        // Prepare params for positions close to liquidation (HF < 1.05)
        // Only if not already preparing or prepared
        if (hfFloat < 1.05 && !preparingUsers.has(user) && !getPreparedParams(user)) {
          toPrepare.push({ user, pool: poolAddress, totalDebtBase });
        }
      }
    });

    // Show result
    if (liquidatable.length > 0) {
      console.log(`[QuickCheck] Found ${liquidatable.length} liquidatable in ${elapsed}ms`);
    } else {
      console.log(`[QuickCheck] OK (${elapsed}ms) - Lowest HF: ${lowestHF.toFixed(4)} (${shortAddr(lowestUser || '0x0000000000000000000000000000000000000000')})`);
    }

    // Prepare params in background for positions very close to liquidation
    // Use BATCH prepare for efficiency (1-2 multicalls vs N multicalls)
    if (toPrepare.length > 0 && liquidatable.length === 0) {
      const toPrepareSorted = toPrepare.sort((a, b) => {
        const hfA = hotPositions.get(a.user)?.hf || 2;
        const hfB = hotPositions.get(b.user)?.hf || 2;
        return hfA - hfB; // Lowest HF first
      }).slice(0, 8);

      // Log which positions we're preparing
      console.log(`[QuickCheck] Batch preparing ${toPrepareSorted.length} positions:`);
      for (const pos of toPrepareSorted) {
        console.log(`  - ${shortAddr(pos.user)} (HF: ${hotPositions.get(pos.user)?.hf?.toFixed(4)})`);
      }

      // Use batch prepare - runs in background (no await)
      batchPreparePositions(toPrepareSorted).catch(err => {
        console.error(`[QuickCheck] Batch prepare error: ${err.message}`);
      });
    }

  } catch (err) {
    console.error(`[QuickCheck] Error: ${err.message}`);
  }

  return liquidatable;
}

/**
 * Execute liquidation with prepared params (FAST PATH)
 */
async function executePreparedLiquidation(prepared, freshHF) {
  const liquidator = new Wallet(config.liquidator_key, txProvider);
  const botContract = new Contract(prepared.botAddress, LiquidationAbi, txProvider);

  const lParam = {
    collateralAsset: prepared.collateralAsset,
    debtAsset: prepared.debtAsset,
    user: prepared.user,
    amount: prepared.debtToCover,
    transferAmount: 0,
    debtToCover: prepared.userDebt.gt(prepared.debtBalanceInmToken)
      ? prepared.debtBalanceInmToken
      : constants.MaxUint256,
  };

  // Calculate expected profit for dynamic gas
  // Debt to cover * 5% bonus = profit (approximately)
  const debtUsd = Number(prepared.debtToCover.toString()) / Math.pow(10, prepared.debtDecimals || 18);
  const profitUsd = debtUsd * 0.05; // ~5% liquidation bonus
  const gasMultiplier = calculateGasMultiplier(profitUsd);

  console.log(`[FastLiquidation] Executing ${prepared.strategy} for ${shortAddr(prepared.user)} (profit ~$${profitUsd.toFixed(2)}, gas ${gasMultiplier/100}x)`);

  try {
    const gasPrice = await provider.getGasPrice();
    const adjustedGasPrice = gasPrice.mul(gasMultiplier).div(100);

    let tx;
    if (prepared.strategy === Strategy.V2_FLASH_SWAP) {
      tx = await botContract
        .connect(liquidator)
        .executeFlashSwap(
          prepared.strategyPool,
          lParam,
          prepared.sParamToRepayLoan,
          prepared.sParamToSendToReceiver,
          liquidator.address,
          { gasLimit: 4000000, gasPrice: adjustedGasPrice }
        );
    } else if (prepared.strategy === Strategy.V3_FLASH) {
      tx = await botContract
        .connect(liquidator)
        .executeFlashV3(
          prepared.strategyPool,
          lParam,
          prepared.sParamToRepayLoan,
          prepared.sParamToSendToReceiver,
          liquidator.address,
          { gasLimit: 4000000, gasPrice: adjustedGasPrice }
        );
    } else {
      tx = await botContract
        .connect(liquidator)
        .execute(
          lParam,
          prepared.sParamToRepayLoan,
          prepared.sParamToSendToReceiver,
          liquidator.address,
          { gasLimit: 4000000, gasPrice: adjustedGasPrice }
        );
    }

    console.log(`[FastLiquidation] TX sent: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      // Remove from prepared cache
      preparedLiquidations.delete(prepared.user);

      const gasUsed = receipt.gasUsed;
      const gasCostWei = gasUsed.mul(tx.gasPrice || receipt.effectiveGasPrice);
      const gasCostFlow = Number(gasCostWei.toString()) / 1e18;

      await sendAlert([
        `✅ <b>FAST Liquidation!</b> ${prepared.strategy}`,
        ``,
        `👤 <a href="${FLOWSCAN_URL}/address/${prepared.user}">${shortAddr(prepared.user)}</a>`,
        `📊 HF: ${(Number(freshHF.toString()) / 1e18).toFixed(4)}`,
        `⚡ Used prepared params`,
        `⛽ Gas: ${gasCostFlow.toFixed(4)} FLOW`,
        ``,
        `🔗 <a href="${FLOWSCAN_URL}/tx/${receipt.transactionHash}">Tx</a>`
      ].join('\n'));

      return { success: true, receipt };
    } else {
      throw new Error('Transaction reverted');
    }
  } catch (err) {
    console.error(`[FastLiquidation] Failed: ${err.message}`);
    // Remove stale prepared params
    preparedLiquidations.delete(prepared.user);
    return { success: false, error: err };
  }
}

// ============================================
// WEBSOCKET BLOCK LISTENER
// ============================================
const WebSocket = require('ws');

let wsConnection = null;
let lastBlockNumber = 0;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT_ATTEMPTS = 10;

function getWebSocketUrl() {
  // Use public Flow WebSocket (free) instead of Alchemy
  return PUBLIC_RPC.replace('https://', 'wss://');
}

async function handleNewBlock(blockNumber) {
  // Skip if we already processed this block
  if (blockNumber <= lastBlockNumber) return;
  lastBlockNumber = blockNumber;

  // Only check if we have hot positions
  if (hotPositions.size === 0) return;

  try {
    const quickLiquidatable = await quickCheckHotPositions();

    if (quickLiquidatable.length > 0) {
      let handledFast = 0;

      for (const liq of quickLiquidatable) {
        if (liq.prepared) {
          console.log(`[WebSocket] ⚡ FAST PATH for ${shortAddr(liq.user)}`);
          const result = await executePreparedLiquidation(liq.prepared, liq.healthFactor);
          if (result.success) handledFast++;
        }
      }

      if (handledFast < quickLiquidatable.length) {
        console.log(`[WebSocket] Triggering full scan for ${quickLiquidatable.length - handledFast} remaining`);
        await main();
      }
    }
  } catch (err) {
    console.error(`[WebSocket] Block handler error: ${err.message?.slice(0, 80)}`);
  }
}

function connectWebSocket() {
  const wsUrl = getWebSocketUrl();
  console.log(`[WebSocket] Connecting to ${wsUrl.slice(0, 50)}...`);

  wsConnection = new WebSocket(wsUrl);

  wsConnection.on('open', () => {
    console.log('[WebSocket] Connected! Subscribing to new blocks...');
    wsReconnectAttempts = 0;

    // Subscribe to new block headers
    wsConnection.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_subscribe',
      params: ['newHeads']
    }));
  });

  wsConnection.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.method === 'eth_subscription' && msg.params?.result?.number) {
        const blockNumber = parseInt(msg.params.result.number, 16);
        // Don't await - let it run async to not block WS
        handleNewBlock(blockNumber).catch(() => {});
      } else if (msg.result && msg.id === 1) {
        console.log(`[WebSocket] Subscribed to newHeads (ID: ${msg.result})`);
      } else if (msg.error) {
        console.error(`[WebSocket] RPC error: ${msg.error.message}`);
      }
    } catch (err) {
      console.error(`[WebSocket] Message parse error: ${err.message}`);
    }
  });

  wsConnection.on('close', () => {
    console.log('[WebSocket] Connection closed');
    wsConnection = null;

    // Reconnect with backoff
    if (wsReconnectAttempts < MAX_WS_RECONNECT_ATTEMPTS) {
      wsReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})`);
      setTimeout(connectWebSocket, delay);
    } else {
      console.log('[WebSocket] Max reconnect attempts reached, falling back to polling');
    }
  });

  wsConnection.on('error', (err) => {
    console.error(`[WebSocket] Error: ${err.message}`);
    // Close will be triggered after error
  });
}

// Run in loop mode (with WebSocket enhancement)
async function runLoop() {
  const intervalMs = (config.loop_interval_seconds || 60) * 1000;
  const fallbackIntervalMs = 3000; // Fallback polling if WS fails
  console.log(`Starting bot in loop mode (full scan: ${intervalMs / 1000}s)`);

  // Try to connect WebSocket for real-time block updates
  try {
    connectWebSocket();
    await sendInfo(`🤖 <b>Bot Started</b>\n\n⚡ WebSocket: Enabled\nFull scan: ${intervalMs / 1000}s\nMin debt: $${config.min_debt_usd || 1}`);
  } catch (err) {
    console.log(`[WebSocket] Failed to connect: ${err.message}`);
    await sendInfo(`🤖 <b>Bot Started</b>\n\n📊 Polling: ${fallbackIntervalMs / 1000}s\nFull scan: ${intervalMs / 1000}s\nMin debt: $${config.min_debt_usd || 1}`);
  }

  let lastFullScan = 0;
  let consecutiveErrors = 0;
  const MAX_SILENT_ERRORS = 3;
  let lastErrorMsg = '';

  while (true) {
    try {
      const now = Date.now();

      // Full scan from subgraph periodically
      if (now - lastFullScan >= intervalMs) {
        await main();
        lastFullScan = now;
      } else if (!wsConnection && hotPositions.size > 0) {
        // Fallback polling only if WebSocket is not connected
        const quickLiquidatable = await quickCheckHotPositions();

        if (quickLiquidatable.length > 0) {
          let handledFast = 0;

          for (const liq of quickLiquidatable) {
            if (liq.prepared) {
              console.log(`[Polling] ⚡ FAST PATH for ${shortAddr(liq.user)}`);
              const result = await executePreparedLiquidation(liq.prepared, liq.healthFactor);
              if (result.success) handledFast++;
            }
          }

          if (handledFast < quickLiquidatable.length) {
            console.log(`[Polling] Triggering full scan for ${quickLiquidatable.length - handledFast} remaining`);
            await main();
            lastFullScan = now;
          } else {
            console.log(`[Polling] ✅ All ${handledFast} liquidations handled via FAST PATH`);
          }
        }
      }

      // Reset error counter on success
      if (consecutiveErrors > 0) {
        console.log(`[Recovery] Bot recovered after ${consecutiveErrors} errors`);
        consecutiveErrors = 0;
        lastErrorMsg = '';
        // Try switching back to public RPC after recovery
        if (usingAlchemyFallback) {
          switchToPublicRpc();
          console.log(`[RPC] Switched back to public RPC after recovery`);
        }
      }
    } catch (err) {
      consecutiveErrors++;
      const errorMsg = err.message?.slice(0, 100) || 'Unknown error';
      console.error(`Loop error (${consecutiveErrors}): ${errorMsg}`);

      const isNetworkError = errorMsg.includes('NETWORK_ERROR') ||
                             errorMsg.includes('could not detect network') ||
                             errorMsg.includes('ECONNREFUSED') ||
                             errorMsg.includes('ENOTFOUND');

      const isTransientError = errorMsg.includes('missing revert data') ||
                               errorMsg.includes('CALL_EXCEPTION') ||
                               errorMsg.includes('timeout') ||
                               errorMsg.includes('ETIMEDOUT') ||
                               errorMsg.includes('processing response error');

      // Switch to Alchemy fallback on network errors after 2 consecutive failures
      if (isNetworkError && consecutiveErrors >= 2 && !usingAlchemyFallback) {
        switchToAlchemyFallback();
        await sendAlert(`🔄 <b>RPC Fallback</b>\n\nSwitched reads to Alchemy\nReason: ${errorMsg.slice(0, 50)}`);
      }

      if (!isTransientError || consecutiveErrors >= MAX_SILENT_ERRORS || errorMsg !== lastErrorMsg) {
        if (consecutiveErrors >= MAX_SILENT_ERRORS) {
          await sendAlert(`⚠️ <b>Bot Error</b> (${consecutiveErrors}x)\n\n<code>${errorMsg}</code>`);
        } else if (!isTransientError && !isNetworkError) {
          await sendAlert(`⚠️ <b>Bot Error</b>\n\n<code>${errorMsg}</code>`);
        }
      }
      lastErrorMsg = errorMsg;
    }

    // Sleep - shorter if WS connected (WS handles real-time), longer if polling
    await sleep(wsConnection ? 10000 : fallbackIntervalMs);
  }
}

// Start the bot
runLoop();
