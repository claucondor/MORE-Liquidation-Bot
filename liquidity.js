/**
 * Liquidity Monitor and Strategy Selector
 *
 * Prioridad de estrategias:
 * 1. V2 FlashSwap (PunchSwap) - 0.3% fee, más simple y directo
 * 2. V3 Flash (FlowSwap) - 0.01%-0.3% fee, bueno para ankrFLOW
 * 3. Eisen + Aave Flash Loan - Última opción, para tokens sin pools directas
 */

const { Contract, BigNumber, utils } = require('ethers');

// ABIs mínimos
const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])"
];

const V2_ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)"
];

const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

const V3_POOL_ABI = [
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)"
];

// StableKitty ABI (Curve-style pools)
const STABLEKITTY_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)"
];

// Estrategias disponibles
const Strategy = {
  STABLEKITTY: 'STABLEKITTY',       // Best for stable↔stable (Curve-style)
  V2_FLASH_SWAP: 'V2_FLASH_SWAP',
  V3_FLASH: 'V3_FLASH',
  EISEN_FLASH_LOAN: 'EISEN_FLASH_LOAN',
  NONE: 'NONE'
};

// Configuración de pools conocidas
const POOLS_CONFIG = {
  // V2 Pairs (PunchSwap) - para FlashSwap
  v2Pairs: {
    'WFLOW_USDF': {
      address: '0x17e96496212d06Eb1Ff10C6f853669Cc9947A1e7',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 30 // 0.3% = 30 bps
    },
    'ANKRFLOW_WFLOW': {
      address: '0x442aE0F33d66F617AF9106e797fc251B574aEdb3',
      token0: '0x1b97100eA1D7126C4d60027e231EA4CB25314bdb', // ankrFLOW
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 30
    },
    'WBTC_WFLOW': {
      address: '0xAebc9efe5599D430Bc9045148992d3df50487ef2',
      token0: '0x717DAE2BaF7656BE9a9B01deE31d571a9d4c9579', // wBTC
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 30
    },
    'WBTC_USDF': {
      address: '0x20E0CaE3EdBd9E5aEC1175c8293626443D3Dca31',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0x717DAE2BaF7656BE9a9B01deE31d571a9d4c9579', // wBTC
      fee: 30
    },
    'WETH_WFLOW': {
      address: '0x681A3c23E7704e5c90e45ABf800996145a8096fD',
      token0: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590', // WETH
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 30
    },
    'TRUMP_WFLOW': {
      address: '0x83900C7FfecE2a47cAC867F87252CdF52Bd017A2',
      token0: '0xD3378b419feae4e3A4Bb4f3349DBa43a1B511760', // TRUMP
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 30
    }
  },

  // V3 Pools (FlowSwap) - para Flash
  v3Pools: {
    'WFLOW_USDF_3000': {
      address: '0xd21C58aDaf1d1119FE40413b45A5f43d23d58DF3',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 3000 // 0.3%
    },
    'ANKRFLOW_WFLOW_100': {
      address: '0xbB577ac54E4641a7e2b38Ce39e794096CD11A639',
      token0: '0x1b97100eA1D7126C4d60027e231EA4CB25314bdb', // ankrFLOW
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      fee: 100 // 0.01% - MUY BARATO
    },
    'WBTC_USDF_3000': {
      address: '0xf1B302b8683b40e1ad089ed6A0aE4F32A75A608f',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0x717DAE2BaF7656BE9a9B01deE31d571a9d4c9579', // wBTC
      fee: 3000
    }
  },

  // Tokens que SOLO funcionan con Eisen (sin pools directas)
  eisenOnly: [
    '0x5598c0652B899EB40f169Dd5949BdBE0BF36ffDe', // stFLOW
    '0x7f27352d5f83db87a5a3e00f4b07cc2138d8ee52', // USDC.e (poca liquidez)
    '0xa0197b2044d28b08be34d98b23c9312158ea9a18'  // cbBTC (sin pools)
  ],

  // StableKitty pools (Curve-style, A=1000) - BEST for stable↔stable swaps
  // Very low slippage for large amounts
  stableKitty: {
    'PYUSD0_stgUSDC': {
      address: '0x0e9712Ad7dbC3c0AC25765f57E8805C3fd3cF717',
      token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
      token1: '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
      token0Index: 0,
      token1Index: 1,
      tvl: 418000 // ~$418k
    },
    'USDF_PYUSD0': {
      address: '0x6ddDFa511A940cA3fD5Ec7F6a4f23947cA30f030',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
      token0Index: 0,
      token1Index: 1,
      tvl: 716000 // ~$716k
    },
    'USDF_stgUSDC': {
      address: '0x20ca5d1C8623ba6AC8f02E41cCAFFe7bb6C92B57',
      token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
      token1: '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
      token0Index: 0,
      token1Index: 1,
      tvl: 1340000 // ~$1.34M (largest)
    }
  },

  // PYUSD0 specific pools
  pyusd0: {
    'PYUSD0_WFLOW_V2': {
      address: '0xfc18d92085fa9df01be5985e5d890b4a4d7edad9',
      token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      type: 'V2',
      fee: 30
    },
    'PYUSD0_stgUSDC_V3': {
      address: '0x3e1368383d45c1cb48310382343df6890fe2d217',
      token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
      token1: '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
      type: 'V3',
      fee: 100 // 0.01%
    },
    'PYUSD0_WFLOW_V3': {
      address: '0x0fdba612fea7a7ad0256687eebf056d81ca63f63',
      token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
      token1: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e', // WFLOW
      type: 'V3',
      fee: 3000 // 0.3%
    }
  }
};

// Tokens conocidos
const TOKENS = {
  WFLOW: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e',
  USDF: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED',
  ankrFLOW: '0x1b97100eA1D7126C4d60027e231EA4CB25314bdb',
  wBTC: '0x717DAE2BaF7656BE9a9B01deE31d571a9d4c9579',
  WETH: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
  stFLOW: '0x5598c0652B899EB40f169Dd5949BdBE0BF36ffDe',
  TRUMP: '0xD3378b419feae4e3A4Bb4f3349DBa43a1B511760',
  stgUSDC: '0xf1815bd50389c46847f0bda824ec8da914045d14',
  'USDC.e': '0x7f27352d5f83db87a5a3e00f4b07cc2138d8ee52',
  cbBTC: '0xa0197b2044d28b08be34d98b23c9312158ea9a18',
  PYUSD0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750',
};

// Stablecoins set (for detecting stable↔stable swaps)
const STABLECOINS = new Set([
  '0x99af3eea856556646c98c8b9b2548fe815240750', // PYUSD0
  '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
  '0x2aabea2058b5ac2d339b163c6ab6f2b6d53aabed', // USDF
]);

/**
 * Cache de liquidez para evitar llamadas repetidas
 */
class LiquidityCache {
  constructor(ttlMs = 10000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clear() {
    this.cache.clear();
  }
}

const liquidityCache = new LiquidityCache(10000); // 10 segundos

/**
 * Obtener liquidez de un V2 pair
 */
async function getV2PairLiquidity(pairAddress, provider) {
  const cacheKey = `v2_${pairAddress}`;
  const cached = liquidityCache.get(cacheKey);
  if (cached) return cached;

  try {
    const pair = new Contract(pairAddress, PAIR_ABI, provider);
    const [reserves, token0, token1] = await Promise.all([
      pair.getReserves(),
      pair.token0(),
      pair.token1()
    ]);

    const result = {
      address: pairAddress,
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      reserve0: BigNumber.from(reserves.reserve0),
      reserve1: BigNumber.from(reserves.reserve1),
      type: 'V2'
    };

    liquidityCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[Liquidity] Error V2 ${pairAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Obtener liquidez de un V3 pool
 */
async function getV3PoolLiquidity(poolAddress, provider) {
  const cacheKey = `v3_${poolAddress}`;
  const cached = liquidityCache.get(cacheKey);
  if (cached) return cached;

  try {
    const pool = new Contract(poolAddress, V3_POOL_ABI, provider);
    const [token0, token1, fee, liquidity] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.fee(),
      pool.liquidity()
    ]);

    // También obtener balances reales del pool
    const tok0 = new Contract(token0, ERC20_ABI, provider);
    const tok1 = new Contract(token1, ERC20_ABI, provider);
    const [bal0, bal1] = await Promise.all([
      tok0.balanceOf(poolAddress),
      tok1.balanceOf(poolAddress)
    ]);

    const result = {
      address: poolAddress,
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      fee: fee,
      liquidity: BigNumber.from(liquidity),
      balance0: BigNumber.from(bal0),
      balance1: BigNumber.from(bal1),
      type: 'V3'
    };

    liquidityCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[Liquidity] Error V3 ${poolAddress}: ${err.message}`);
    return null;
  }
}

// ============================================
// STABLEKITTY FUNCTIONS
// ============================================

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

  for (const [name, pool] of Object.entries(POOLS_CONFIG.stableKitty || {})) {
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
 * Get StableKitty pool liquidity
 */
async function getStableKittyLiquidity(poolAddress, provider) {
  const cacheKey = `sk_${poolAddress}`;
  const cached = liquidityCache.get(cacheKey);
  if (cached) return cached;

  try {
    const pool = new Contract(poolAddress, STABLEKITTY_ABI, provider);
    const [bal0, bal1] = await Promise.all([
      pool.balances(0),
      pool.balances(1),
    ]);

    const result = {
      address: poolAddress,
      balance0: BigNumber.from(bal0),
      balance1: BigNumber.from(bal1),
      // Both stables are 6 decimals
      tvlUsd: (Number(bal0) + Number(bal1)) / 1e6,
      type: 'STABLEKITTY'
    };

    liquidityCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.log(`[Liquidity] Error StableKitty ${poolAddress}: ${err.message}`);
    return null;
  }
}

/**
 * Get quote from StableKitty pool
 */
async function getStableKittyQuote(pool, amountIn, provider) {
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
 * Find PYUSD0 pool for a token
 */
function findPYUSD0Pool(tokenAddress) {
  const tokenLower = tokenAddress.toLowerCase();
  const pyusd0Lower = TOKENS.PYUSD0.toLowerCase();

  // Check if token is PYUSD0 or pairs with PYUSD0
  for (const [name, pool] of Object.entries(POOLS_CONFIG.pyusd0 || {})) {
    const p0 = pool.token0.toLowerCase();
    const p1 = pool.token1.toLowerCase();

    if ((tokenLower === p0 || tokenLower === p1) &&
        (p0 === pyusd0Lower || p1 === pyusd0Lower)) {
      return { name, ...pool };
    }
  }
  return null;
}

/**
 * Encontrar V2 pair que contenga el token
 */
function findV2PairForToken(tokenAddress) {
  const tokenLower = tokenAddress.toLowerCase();

  for (const [name, config] of Object.entries(POOLS_CONFIG.v2Pairs)) {
    if (config.token0.toLowerCase() === tokenLower ||
        config.token1.toLowerCase() === tokenLower) {
      return { name, ...config };
    }
  }
  return null;
}

/**
 * Encontrar V3 pool que contenga el token (preferir la de menor fee)
 */
function findV3PoolForToken(tokenAddress) {
  const tokenLower = tokenAddress.toLowerCase();
  let bestPool = null;

  for (const [name, config] of Object.entries(POOLS_CONFIG.v3Pools)) {
    if (config.token0.toLowerCase() === tokenLower ||
        config.token1.toLowerCase() === tokenLower) {
      if (!bestPool || config.fee < bestPool.fee) {
        bestPool = { name, ...config };
      }
    }
  }
  return bestPool;
}

/**
 * Calcular slippage esperado para V2 swap
 * Fórmula: slippage = amountIn / reserve * 100
 */
function calculateV2Slippage(amountIn, reserveIn) {
  if (reserveIn.isZero()) return 100;
  // slippage = (amountIn / reserveIn) * 100
  const slippageBps = amountIn.mul(10000).div(reserveIn);
  return Number(slippageBps.toString()) / 100; // Retorna porcentaje
}

/**
 * Calcular output esperado para V2 swap (con fee 0.3%)
 */
function calculateV2Output(amountIn, reserveIn, reserveOut) {
  // amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
  const amountInWithFee = amountIn.mul(997);
  const numerator = amountInWithFee.mul(reserveOut);
  const denominator = reserveIn.mul(1000).add(amountInWithFee);
  return numerator.div(denominator);
}

/**
 * Calcular cantidad máxima que se puede swapear con slippage aceptable
 * @param {BigNumber} reserveIn - Reserva del token de entrada
 * @param {number} maxSlippagePct - Slippage máximo aceptable (ej: 2 para 2%)
 */
function calculateMaxSwapAmount(reserveIn, maxSlippagePct = 2) {
  // Si queremos máximo 2% slippage, podemos swapear máximo 2% de la reserva
  return reserveIn.mul(Math.floor(maxSlippagePct * 100)).div(10000);
}

/**
 * Determinar la mejor estrategia para una liquidación
 *
 * @param {string} collateralAsset - Token colateral a recibir
 * @param {string} debtAsset - Token deuda a pagar
 * @param {BigNumber} debtAmount - Cantidad de deuda a cubrir
 * @param {BigNumber} collateralAmount - Cantidad esperada de colateral
 * @param {object} provider - Ethers provider
 * @returns {object} Estrategia recomendada con detalles
 */
async function selectBestStrategy(collateralAsset, debtAsset, debtAmount, collateralAmount, provider) {
  const collateralLower = collateralAsset.toLowerCase();
  const debtLower = debtAsset.toLowerCase();
  const wflowLower = TOKENS.WFLOW.toLowerCase();

  console.log(`[Strategy] Evaluando: ${collateralLower.slice(0,8)}... -> ${debtLower.slice(0,8)}...`);

  // Check si el token es "Eisen only"
  const isEisenOnly = POOLS_CONFIG.eisenOnly.some(t =>
    t.toLowerCase() === collateralLower || t.toLowerCase() === debtLower
  );

  if (isEisenOnly) {
    console.log(`[Strategy] Token requiere Eisen (sin pools directas)`);
    return {
      strategy: Strategy.EISEN_FLASH_LOAN,
      reason: 'Token sin pools directas',
      pool: null,
      fee: 5, // 0.05% Aave + swap fees
      maxAmount: null,
      slippage: null
    };
  }

  const results = [];

  // ============================================
  // 0. Evaluar StableKitty (BEST for stable↔stable)
  // ============================================
  if (isStableSwap(collateralAsset, debtAsset)) {
    console.log(`[Strategy] Stable↔Stable swap detected, checking StableKitty...`);

    const stablePool = findStableKittyPool(collateralAsset, debtAsset);
    if (stablePool) {
      const liquidity = await getStableKittyLiquidity(stablePool.address, provider);

      if (liquidity && liquidity.tvlUsd > 10000) {
        // StableKitty has very low slippage for stables
        const debtUsd = Number(debtAmount.toString()) / 1e6; // Assuming 6 decimals
        const slippage = debtUsd / liquidity.tvlUsd * 100; // Approximate slippage

        results.push({
          strategy: Strategy.STABLEKITTY,
          pool: stablePool.address,
          poolName: stablePool.name,
          fee: 4, // ~0.04% StableKitty fee
          hasLiquidity: true,
          tvlUsd: liquidity.tvlUsd,
          slippage: slippage,
          maxAmount: BigNumber.from(Math.floor(liquidity.tvlUsd * 0.3 * 1e6)), // 30% of TVL
          score: 150 - slippage * 5 // High score for StableKitty
        });

        console.log(`[Strategy] StableKitty ${stablePool.name}: TVL=$${liquidity.tvlUsd.toLocaleString()}, slippage=${slippage.toFixed(2)}%`);
      }
    }
  }

  // ============================================
  // 1. Evaluar V2 FlashSwap
  // ============================================
  // Para flash swap necesitamos un pair que contenga el debtAsset
  const v2Pair = findV2PairForToken(debtAsset);

  if (v2Pair) {
    const liquidity = await getV2PairLiquidity(v2Pair.address, provider);

    if (liquidity) {
      // Para flash swap necesitamos:
      // 1. Flash loan de debtAsset
      // 2. Liquidar → recibimos collateral
      // 3. Swap collateral → debtAsset para pagar flash loan
      // Entonces necesitamos verificar la reserva del COLLATERAL (no debt)

      const isCollateralToken0 = liquidity.token0 === collateralLower;
      const collateralReserve = isCollateralToken0 ? liquidity.reserve0 : liquidity.reserve1;
      const debtReserve = isCollateralToken0 ? liquidity.reserve1 : liquidity.reserve0;

      // Para liquidar X debt, recibimos ~1.05X worth de collateral
      // Ese collateral lo tenemos que swapear por debt
      // Aproximación: collateralNeeded ≈ debtAmount (en value)
      const hasLiquidity = collateralReserve.gte(debtAmount); // Simplificado: asume 1:1 ratio
      const slippage = calculateV2Slippage(debtAmount, collateralReserve); // Slippage al swapear collateral
      const maxAmount = calculateMaxSwapAmount(collateralReserve, 10); // Max 10% slippage permitido

      results.push({
        strategy: Strategy.V2_FLASH_SWAP,
        pool: v2Pair.address,
        poolName: v2Pair.name,
        fee: 30, // 0.3% = 30 bps
        hasLiquidity,
        reserve: debtReserve.toString(),
        slippage,
        maxAmount,
        score: hasLiquidity ? (100 - slippage * 10) : 0 // Score basado en slippage
      });

      console.log(`[Strategy] V2 ${v2Pair.name}: liquidity=${hasLiquidity}, slippage=${slippage.toFixed(2)}%`);
    }
  }

  // ============================================
  // 2. Evaluar V3 Flash (segunda opción)
  // ============================================
  const v3Pool = findV3PoolForToken(debtAsset);

  if (v3Pool) {
    const liquidity = await getV3PoolLiquidity(v3Pool.address, provider);

    if (liquidity && !liquidity.liquidity.isZero()) {
      // Para V3, usar balances reales
      const isDebtToken0 = liquidity.token0 === debtLower;
      const debtBalance = isDebtToken0 ? liquidity.balance0 : liquidity.balance1;

      const hasLiquidity = debtBalance.gte(debtAmount);
      // V3 slippage es más complejo, usar aproximación
      const slippage = calculateV2Slippage(debtAmount, debtBalance);

      // Bonus por fee bajo (ankrFLOW pool tiene 0.01%)
      const feeBonus = v3Pool.fee === 100 ? 20 : 0;

      results.push({
        strategy: Strategy.V3_FLASH,
        pool: v3Pool.address,
        poolName: v3Pool.name,
        fee: v3Pool.fee / 100, // Convertir a bps (3000 -> 30 bps)
        hasLiquidity,
        balance: debtBalance.toString(),
        slippage,
        score: hasLiquidity ? (90 - slippage * 10 + feeBonus) : 0
      });

      console.log(`[Strategy] V3 ${v3Pool.name}: liquidity=${hasLiquidity}, fee=${v3Pool.fee/10000}%, slippage=${slippage.toFixed(2)}%`);
    }
  }

  // ============================================
  // 3. Seleccionar mejor estrategia
  // ============================================

  // Filtrar solo las que tienen liquidez y ordenar por score
  const validStrategies = results
    .filter(r => r.hasLiquidity && r.slippage < 10) // Max 10% slippage
    .sort((a, b) => b.score - a.score);

  if (validStrategies.length > 0) {
    const best = validStrategies[0];
    console.log(`[Strategy] Mejor: ${best.strategy} (${best.poolName}) score=${best.score.toFixed(0)}`);
    return {
      strategy: best.strategy,
      reason: `${best.poolName} - slippage ${best.slippage.toFixed(2)}%`,
      pool: best.pool,
      fee: best.fee,
      maxAmount: best.maxAmount,
      slippage: best.slippage,
      alternatives: validStrategies.slice(1)
    };
  }

  // Si no hay estrategias válidas, usar Eisen
  console.log(`[Strategy] Sin pools con liquidez suficiente, usando Eisen`);
  return {
    strategy: Strategy.EISEN_FLASH_LOAN,
    reason: 'Pools sin liquidez suficiente',
    pool: null,
    fee: 5,
    maxAmount: null,
    slippage: null
  };
}

/**
 * Calcular cantidad óptima a liquidar basado en liquidez disponible
 *
 * @param {BigNumber} maxDebt - Deuda máxima liquidable (50% del total)
 * @param {BigNumber} poolLiquidity - Liquidez disponible en el pool
 * @param {number} maxSlippagePct - Slippage máximo aceptable
 * @returns {BigNumber} Cantidad óptima a liquidar
 */
function calculateOptimalLiquidationAmount(maxDebt, poolLiquidity, maxSlippagePct = 3) {
  // Cantidad máxima que podemos swapear con slippage aceptable
  const maxSwap = calculateMaxSwapAmount(poolLiquidity, maxSlippagePct);

  // Liquidar el mínimo entre deuda máxima y lo que el pool aguanta
  if (maxSwap.lt(maxDebt)) {
    console.log(`[Optimal] Reduciendo liquidación: ${maxDebt.toString()} -> ${maxSwap.toString()} (pool limit)`);
    return maxSwap;
  }

  return maxDebt;
}

/**
 * Obtener resumen de liquidez de todos los pools
 */
async function getLiquiditySummary(provider) {
  const summary = {
    v2Pairs: {},
    v3Pools: {},
    stableKitty: {},
    pyusd0Pools: {},
    timestamp: Date.now()
  };

  // StableKitty pools (best for stables)
  for (const [name, config] of Object.entries(POOLS_CONFIG.stableKitty || {})) {
    const liquidity = await getStableKittyLiquidity(config.address, provider);
    if (liquidity) {
      summary.stableKitty[name] = {
        address: config.address,
        tvlUsd: liquidity.tvlUsd,
        balance0: liquidity.balance0.toString(),
        balance1: liquidity.balance1.toString()
      };
    }
  }

  // PYUSD0 pools
  for (const [name, config] of Object.entries(POOLS_CONFIG.pyusd0 || {})) {
    if (config.type === 'V2') {
      const liquidity = await getV2PairLiquidity(config.address, provider);
      if (liquidity) {
        summary.pyusd0Pools[name] = {
          address: config.address,
          type: 'V2',
          reserve0: liquidity.reserve0.toString(),
          reserve1: liquidity.reserve1.toString()
        };
      }
    } else if (config.type === 'V3') {
      const liquidity = await getV3PoolLiquidity(config.address, provider);
      if (liquidity) {
        summary.pyusd0Pools[name] = {
          address: config.address,
          type: 'V3',
          fee: config.fee,
          balance0: liquidity.balance0.toString(),
          balance1: liquidity.balance1.toString()
        };
      }
    }
  }

  // V2 Pairs
  for (const [name, config] of Object.entries(POOLS_CONFIG.v2Pairs)) {
    const liquidity = await getV2PairLiquidity(config.address, provider);
    if (liquidity) {
      summary.v2Pairs[name] = {
        address: config.address,
        reserve0: liquidity.reserve0.toString(),
        reserve1: liquidity.reserve1.toString()
      };
    }
  }

  // V3 Pools
  for (const [name, config] of Object.entries(POOLS_CONFIG.v3Pools)) {
    const liquidity = await getV3PoolLiquidity(config.address, provider);
    if (liquidity) {
      summary.v3Pools[name] = {
        address: config.address,
        fee: config.fee,
        balance0: liquidity.balance0.toString(),
        balance1: liquidity.balance1.toString()
      };
    }
  }

  return summary;
}

/**
 * Calcular slippage dinámico basado en tamaño de posición
 * Posiciones grandes = más slippage permitido
 */
function calculateDynamicSlippage(debtUsd) {
  if (debtUsd < 100) return 0.02;      // 2% para posiciones pequeñas
  if (debtUsd < 1000) return 0.03;     // 3% para medianas
  if (debtUsd < 10000) return 0.05;    // 5% para grandes
  return 0.08;                          // 8% para muy grandes
}

// ============================================
// BATCH QUOTES (Multicall3)
// ============================================

// Interfaces for encoding/decoding
const v2RouterIface = new utils.Interface(V2_ROUTER_ABI);
const stableKittyIface = new utils.Interface(STABLEKITTY_ABI);
const v3PoolIface = new utils.Interface(V3_POOL_ABI);

/**
 * Calculate V3 swap output from sqrtPriceX96
 * Works for small-medium swaps relative to liquidity
 *
 * @param {BigNumber} sqrtPriceX96 - Current sqrt price from slot0
 * @param {BigNumber} amountIn - Amount to swap
 * @param {boolean} zeroForOne - true if swapping token0 for token1
 * @param {number} fee - Pool fee in hundredths of a bip (e.g., 100 = 0.01%)
 * @returns {BigNumber} Expected output amount
 */
function calculateV3OutputFromSqrtPrice(sqrtPriceX96, amountIn, zeroForOne, fee) {
  const Q96 = BigNumber.from(2).pow(96);
  const sqrtPrice = BigNumber.from(sqrtPriceX96);

  // Fee factor: 1000000 - fee (e.g., 999900 for 0.01% fee)
  const feeFactor = BigNumber.from(1000000 - fee);

  if (zeroForOne) {
    // Selling token0 for token1
    // price = sqrtPrice^2 / 2^192
    // amountOut = amountIn * price * (1 - fee)
    const priceNum = sqrtPrice.mul(sqrtPrice);
    const priceDenom = Q96.mul(Q96);

    return BigNumber.from(amountIn)
      .mul(priceNum)
      .mul(feeFactor)
      .div(priceDenom)
      .div(1000000);
  } else {
    // Selling token1 for token0
    // amountOut = amountIn / price * (1 - fee)
    const priceNum = Q96.mul(Q96);
    const priceDenom = sqrtPrice.mul(sqrtPrice);

    return BigNumber.from(amountIn)
      .mul(priceNum)
      .mul(feeFactor)
      .div(priceDenom)
      .div(1000000);
  }
}

/**
 * Batch multiple quotes in a single RPC call using Multicall3
 *
 * @param {Array} quotes - Array of quote requests:
 *   V2: { type: 'v2', router, amountIn, path }
 *   StableKitty: { type: 'stablekitty', pool, i, j, amountIn }
 *   V3: { type: 'v3', pool, tokenIn, amountIn, fee }
 * @param {string} multicallAddress - Multicall3 contract address
 * @param {object} provider - Ethers provider
 * @returns {Array} Results with { success, amountOut, error? }
 */
async function batchQuotes(quotes, multicallAddress, provider) {
  if (!quotes || quotes.length === 0) return [];

  const multicall = new Contract(multicallAddress, MULTICALL3_ABI, provider);

  // Build calls array
  const calls = [];
  const quoteMeta = []; // Track metadata for decoding

  for (const q of quotes) {
    if (q.type === 'v2') {
      calls.push({
        target: q.router,
        allowFailure: true,
        callData: v2RouterIface.encodeFunctionData('getAmountsOut', [q.amountIn, q.path])
      });
      quoteMeta.push({ type: 'v2', pathLength: q.path.length });

    } else if (q.type === 'stablekitty') {
      calls.push({
        target: q.pool,
        allowFailure: true,
        callData: stableKittyIface.encodeFunctionData('get_dy', [q.i, q.j, q.amountIn])
      });
      quoteMeta.push({ type: 'stablekitty' });

    } else if (q.type === 'v3') {
      // For V3, we get slot0 and calculate locally
      calls.push({
        target: q.pool,
        allowFailure: true,
        callData: v3PoolIface.encodeFunctionData('slot0', [])
      });
      quoteMeta.push({
        type: 'v3',
        tokenIn: q.tokenIn,
        token0: q.token0,
        amountIn: q.amountIn,
        fee: q.fee
      });
    }
  }

  // Execute multicall
  let results;
  try {
    results = await multicall.aggregate3(calls);
  } catch (err) {
    console.log(`[BatchQuotes] Multicall error: ${err.message}`);
    return quotes.map(() => ({ success: false, error: 'Multicall failed' }));
  }

  // Decode results
  const decoded = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const meta = quoteMeta[i];
    const q = quotes[i];

    if (!r.success) {
      decoded.push({ ...q, success: false, error: 'Call failed' });
      continue;
    }

    try {
      if (meta.type === 'v2') {
        const amounts = v2RouterIface.decodeFunctionResult('getAmountsOut', r.returnData);
        decoded.push({
          ...q,
          success: true,
          amountOut: amounts.amounts[meta.pathLength - 1]
        });

      } else if (meta.type === 'stablekitty') {
        const out = stableKittyIface.decodeFunctionResult('get_dy', r.returnData);
        decoded.push({
          ...q,
          success: true,
          amountOut: BigNumber.from(out[0])
        });

      } else if (meta.type === 'v3') {
        const slot0 = v3PoolIface.decodeFunctionResult('slot0', r.returnData);
        const sqrtPriceX96 = slot0.sqrtPriceX96;

        // Determine swap direction
        const zeroForOne = meta.tokenIn.toLowerCase() === meta.token0.toLowerCase();

        // Calculate output from sqrt price
        const amountOut = calculateV3OutputFromSqrtPrice(
          sqrtPriceX96,
          meta.amountIn,
          zeroForOne,
          meta.fee
        );

        decoded.push({
          ...q,
          success: true,
          amountOut,
          sqrtPriceX96: sqrtPriceX96.toString()
        });
      }
    } catch (err) {
      decoded.push({ ...q, success: false, error: err.message });
    }
  }

  return decoded;
}

/**
 * Get real quotes for a swap using batch multicall
 * Automatically detects the best pools and returns quotes from all available sources
 *
 * @param {string} tokenIn - Input token address
 * @param {string} tokenOut - Output token address
 * @param {BigNumber} amountIn - Amount to swap
 * @param {string} multicallAddress - Multicall3 contract address
 * @param {string} v2RouterAddress - PunchSwap router address
 * @param {object} provider - Ethers provider
 * @returns {object} Best quote and all alternatives
 */
async function getSwapQuotes(tokenIn, tokenOut, amountIn, multicallAddress, v2RouterAddress, provider) {
  const tokenInLower = tokenIn.toLowerCase();
  const tokenOutLower = tokenOut.toLowerCase();
  const wflowLower = TOKENS.WFLOW.toLowerCase();

  const quotes = [];

  // 1. Check StableKitty (if stable↔stable)
  if (isStableSwap(tokenIn, tokenOut)) {
    const skPool = findStableKittyPool(tokenIn, tokenOut);
    if (skPool) {
      quotes.push({
        type: 'stablekitty',
        name: `StableKitty ${skPool.name}`,
        pool: skPool.address,
        i: skPool.inputIndex,
        j: skPool.outputIndex,
        amountIn,
        fee: 4 // ~0.04% fee
      });
    }
  }

  // 2. Check V2 direct path
  const v2Pair = findV2PairForToken(tokenIn);
  if (v2Pair) {
    const pair0 = v2Pair.token0.toLowerCase();
    const pair1 = v2Pair.token1.toLowerCase();

    // Direct swap possible?
    if ((tokenInLower === pair0 || tokenInLower === pair1) &&
        (tokenOutLower === pair0 || tokenOutLower === pair1)) {
      quotes.push({
        type: 'v2',
        name: `V2 ${v2Pair.name}`,
        router: v2RouterAddress,
        amountIn,
        path: [tokenIn, tokenOut],
        fee: 30 // 0.3%
      });
    } else if (tokenOutLower === wflowLower || tokenInLower === wflowLower) {
      // Single hop through WFLOW
      quotes.push({
        type: 'v2',
        name: `V2 ${v2Pair.name}`,
        router: v2RouterAddress,
        amountIn,
        path: [tokenIn, tokenOut],
        fee: 30
      });
    } else {
      // Multi-hop through WFLOW
      quotes.push({
        type: 'v2',
        name: `V2 via WFLOW`,
        router: v2RouterAddress,
        amountIn,
        path: [tokenIn, TOKENS.WFLOW, tokenOut],
        fee: 60 // 0.6% (two hops)
      });
    }
  }

  // 3. Check ALL V3 pools that can do this swap
  for (const [name, v3Pool] of Object.entries(POOLS_CONFIG.v3Pools)) {
    const pool0 = v3Pool.token0.toLowerCase();
    const pool1 = v3Pool.token1.toLowerCase();

    // Check if this pool can do the swap (both tokens must be in pool)
    if ((tokenInLower === pool0 || tokenInLower === pool1) &&
        (tokenOutLower === pool0 || tokenOutLower === pool1)) {
      quotes.push({
        type: 'v3',
        name: `V3 ${name}`,
        pool: v3Pool.address,
        tokenIn,
        token0: v3Pool.token0,
        amountIn,
        fee: v3Pool.fee
      });
    }
  }

  if (quotes.length === 0) {
    return { best: null, alternatives: [], error: 'No pools found' };
  }

  // Execute batch quotes
  const results = await batchQuotes(quotes, multicallAddress, provider);

  // Filter successful and sort by output
  const successful = results
    .filter(r => r.success && r.amountOut && !r.amountOut.isZero())
    .sort((a, b) => {
      // Higher output is better
      if (b.amountOut.gt(a.amountOut)) return 1;
      if (a.amountOut.gt(b.amountOut)) return -1;
      return 0;
    });

  if (successful.length === 0) {
    return { best: null, alternatives: [], error: 'All quotes failed' };
  }

  return {
    best: successful[0],
    alternatives: successful.slice(1)
  };
}

/**
 * Batch get swap quotes for MULTIPLE pairs in a SINGLE multicall
 * Much more efficient than calling getSwapQuotes multiple times
 *
 * @param {Array} pairs - Array of {tokenIn, tokenOut, amountIn, id?}
 * @param {string} multicallAddress - Multicall3 contract address
 * @param {string} v2RouterAddress - PunchSwap router address
 * @param {object} provider - Ethers provider
 * @returns {Array} Array of {id, best, alternatives} for each pair
 */
async function batchGetSwapQuotes(pairs, multicallAddress, v2RouterAddress, provider) {
  const allQuotes = [];
  const pairIndexMap = []; // Track which quotes belong to which pair

  // Build all quotes for all pairs
  for (let pairIdx = 0; pairIdx < pairs.length; pairIdx++) {
    const { tokenIn, tokenOut, amountIn, id } = pairs[pairIdx];
    const tokenInLower = tokenIn.toLowerCase();
    const tokenOutLower = tokenOut.toLowerCase();
    const wflowLower = TOKENS.WFLOW.toLowerCase();

    // 1. Check StableKitty
    if (isStableSwap(tokenIn, tokenOut)) {
      const skPool = findStableKittyPool(tokenIn, tokenOut);
      if (skPool) {
        allQuotes.push({
          type: 'stablekitty',
          name: `StableKitty ${skPool.name}`,
          pool: skPool.address,
          i: skPool.inputIndex,
          j: skPool.outputIndex,
          amountIn,
          fee: 4
        });
        pairIndexMap.push({ pairIdx, id });
      }
    }

    // 2. Check V2
    const v2Pair = findV2PairForToken(tokenIn);
    if (v2Pair) {
      const pair0 = v2Pair.token0.toLowerCase();
      const pair1 = v2Pair.token1.toLowerCase();

      if ((tokenInLower === pair0 || tokenInLower === pair1) &&
          (tokenOutLower === pair0 || tokenOutLower === pair1)) {
        allQuotes.push({
          type: 'v2',
          name: `V2 ${v2Pair.name}`,
          router: v2RouterAddress,
          amountIn,
          path: [tokenIn, tokenOut],
          fee: 30
        });
        pairIndexMap.push({ pairIdx, id });
      } else if (tokenOutLower === wflowLower || tokenInLower === wflowLower) {
        allQuotes.push({
          type: 'v2',
          name: `V2 ${v2Pair.name}`,
          router: v2RouterAddress,
          amountIn,
          path: [tokenIn, tokenOut],
          fee: 30
        });
        pairIndexMap.push({ pairIdx, id });
      } else {
        allQuotes.push({
          type: 'v2',
          name: `V2 via WFLOW`,
          router: v2RouterAddress,
          amountIn,
          path: [tokenIn, TOKENS.WFLOW, tokenOut],
          fee: 60
        });
        pairIndexMap.push({ pairIdx, id });
      }
    }

    // 3. Check ALL V3 pools
    for (const [name, v3Pool] of Object.entries(POOLS_CONFIG.v3Pools)) {
      const pool0 = v3Pool.token0.toLowerCase();
      const pool1 = v3Pool.token1.toLowerCase();

      if ((tokenInLower === pool0 || tokenInLower === pool1) &&
          (tokenOutLower === pool0 || tokenOutLower === pool1)) {
        allQuotes.push({
          type: 'v3',
          name: `V3 ${name}`,
          pool: v3Pool.address,
          tokenIn,
          token0: v3Pool.token0,
          amountIn,
          fee: v3Pool.fee
        });
        pairIndexMap.push({ pairIdx, id });
      }
    }
  }

  if (allQuotes.length === 0) {
    return pairs.map(p => ({ id: p.id, best: null, alternatives: [], error: 'No pools found' }));
  }

  // Execute ONE multicall for ALL quotes
  const results = await batchQuotes(allQuotes, multicallAddress, provider);

  // Group results by pair
  const pairResults = pairs.map(p => ({
    id: p.id,
    quotes: []
  }));

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { pairIdx, id } = pairIndexMap[i];

    if (result.success && result.amountOut && !result.amountOut.isZero()) {
      pairResults[pairIdx].quotes.push(result);
    }
  }

  // Sort and return best + alternatives for each pair
  return pairResults.map(pr => {
    if (pr.quotes.length === 0) {
      return { id: pr.id, best: null, alternatives: [], error: 'All quotes failed' };
    }

    // Sort by output (highest first)
    pr.quotes.sort((a, b) => {
      if (b.amountOut.gt(a.amountOut)) return 1;
      if (a.amountOut.gt(b.amountOut)) return -1;
      return 0;
    });

    return {
      id: pr.id,
      best: pr.quotes[0],
      alternatives: pr.quotes.slice(1)
    };
  });
}

module.exports = {
  Strategy,
  POOLS_CONFIG,
  TOKENS,
  STABLECOINS,
  STABLEKITTY_ABI,
  // Strategy selection
  selectBestStrategy,
  calculateOptimalLiquidationAmount,
  // Calculations
  calculateV2Slippage,
  calculateV2Output,
  calculateMaxSwapAmount,
  calculateDynamicSlippage,
  calculateV3OutputFromSqrtPrice,
  // Liquidity queries
  getLiquiditySummary,
  getV2PairLiquidity,
  getV3PoolLiquidity,
  getStableKittyLiquidity,
  getStableKittyQuote,
  // Pool finders
  findV2PairForToken,
  findV3PoolForToken,
  findStableKittyPool,
  findPYUSD0Pool,
  isStableSwap,
  // Batch quotes (Multicall3)
  batchQuotes,
  getSwapQuotes,
  batchGetSwapQuotes,
  // Cache
  liquidityCache
};
