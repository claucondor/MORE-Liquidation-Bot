/**
 * Liquidity Monitor and Strategy Selector
 *
 * Prioridad de estrategias:
 * 1. V2 FlashSwap (PunchSwap) - 0.3% fee, más simple y directo
 * 2. V3 Flash (FlowSwap) - 0.01%-0.3% fee, bueno para ankrFLOW
 * 3. Eisen + Aave Flash Loan - Última opción, para tokens sin pools directas
 */

const { Contract, BigNumber } = require('ethers');

// ABIs mínimos
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

// Estrategias disponibles
const Strategy = {
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
    '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC (poca liquidez)
    '0x7f27352d5f83db87a5a3e00f4b07cc2138d8ee52', // USDC.e (poca liquidez)
    '0xa0197b2044d28b08be34d98b23c9312158ea9a18'  // cbBTC (sin pools)
  ]
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
  cbBTC: '0xa0197b2044d28b08be34d98b23c9312158ea9a18'
};

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
  // 1. Evaluar V2 FlashSwap (primera opción)
  // ============================================
  // Para flash swap necesitamos un pair que contenga el debtAsset
  const v2Pair = findV2PairForToken(debtAsset);

  if (v2Pair) {
    const liquidity = await getV2PairLiquidity(v2Pair.address, provider);

    if (liquidity) {
      // Determinar cuál reserva es el debtAsset
      const isDebtToken0 = liquidity.token0 === debtLower;
      const debtReserve = isDebtToken0 ? liquidity.reserve0 : liquidity.reserve1;
      const otherReserve = isDebtToken0 ? liquidity.reserve1 : liquidity.reserve0;

      // Verificar si hay suficiente liquidez
      const hasLiquidity = debtReserve.gte(debtAmount);
      const slippage = calculateV2Slippage(debtAmount, debtReserve);
      const maxAmount = calculateMaxSwapAmount(debtReserve, 5); // Max 5% slippage

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
    timestamp: Date.now()
  };

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

module.exports = {
  Strategy,
  POOLS_CONFIG,
  TOKENS,
  selectBestStrategy,
  calculateOptimalLiquidationAmount,
  calculateV2Slippage,
  calculateV2Output,
  calculateMaxSwapAmount,
  calculateDynamicSlippage,
  getLiquiditySummary,
  getV2PairLiquidity,
  getV3PoolLiquidity,
  findV2PairForToken,
  findV3PoolForToken,
  liquidityCache
};
