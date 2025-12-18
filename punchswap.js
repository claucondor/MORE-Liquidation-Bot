/**
 * PunchSwap V2 utilities for Flash Swap liquidations
 */
const { utils, BigNumber, Contract } = require("ethers");

// PunchSwap V2 Router ABI (minimal)
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
  "function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)"
];

// PunchSwap V2 Pair ABI (minimal)
const PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"
];

// PunchSwap V2 Factory ABI (minimal)
const FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];

// SwapType enum matching contract
const SwapType = {
  V2: 0,
  V3: 1,
  AggroKitty: 2,
  ApiAggregator: 3
};

/**
 * Build V2 swap params for PunchSwap
 * @param {Object} params
 * @param {string} params.fromToken - Token to swap from
 * @param {string} params.toToken - Token to swap to
 * @param {string} params.amountIn - Amount in (wei string)
 * @param {string} params.router - Router address
 * @param {number} params.slippage - Slippage tolerance (0.01 = 1%)
 * @param {Object} params.provider - Ethers provider
 * @returns {Object} { swapParams, quote }
 */
async function buildV2SwapParams({
  fromToken,
  toToken,
  amountIn,
  router,
  slippage = 0.02,
  provider
}) {
  const routerContract = new Contract(router, ROUTER_ABI, provider);

  const path = [fromToken, toToken];

  // Get quote
  const amounts = await routerContract.getAmountsOut(amountIn, path);
  const expectedOutput = amounts[amounts.length - 1];

  // Apply slippage
  const slippageBps = Math.floor(slippage * 10000);
  const minOutput = expectedOutput.mul(10000 - slippageBps).div(10000);

  // Encode path for V2 (abi.encode(address[]))
  const encodedPath = utils.defaultAbiCoder.encode(["address[]"], [path]);

  const swapParams = {
    swapType: SwapType.V2,
    router: router,
    path: encodedPath,
    amountIn: amountIn.toString(),
    amountOutMin: minOutput.toString(),
    adapters: []
  };

  return {
    swapParams,
    quote: {
      expectedOutput: expectedOutput.toString(),
      minOutput: minOutput.toString(),
      path,
      slippage
    }
  };
}

/**
 * Build empty swap params (for reward when debt is WFLOW)
 */
function buildEmptySwapParams() {
  return {
    swapType: SwapType.V2,
    router: "0x0000000000000000000000000000000000000000",
    path: "0x",
    amountIn: "0",
    amountOutMin: "0",
    adapters: []
  };
}

/**
 * Get pair address for two tokens
 * @param {string} tokenA
 * @param {string} tokenB
 * @param {string} factory - Factory address
 * @param {Object} provider
 * @returns {string|null} Pair address or null if doesn't exist
 */
async function getPairAddress(tokenA, tokenB, factory, provider) {
  const factoryContract = new Contract(factory, FACTORY_ABI, provider);
  const pair = await factoryContract.getPair(tokenA, tokenB);

  if (pair === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  return pair;
}

/**
 * Check if pair has sufficient liquidity
 * @param {string} pairAddress
 * @param {BigNumber} requiredAmount - Amount needed to borrow
 * @param {string} tokenNeeded - Token we want to borrow
 * @param {Object} provider
 * @returns {Object} { hasLiquidity, reserve, ratio }
 */
async function checkPairLiquidity(pairAddress, requiredAmount, tokenNeeded, provider) {
  const pairContract = new Contract(pairAddress, PAIR_ABI, provider);

  const [token0, reserves] = await Promise.all([
    pairContract.token0(),
    pairContract.getReserves()
  ]);

  const isToken0 = token0.toLowerCase() === tokenNeeded.toLowerCase();
  const reserve = isToken0 ? BigNumber.from(reserves.reserve0) : BigNumber.from(reserves.reserve1);

  // Need at least 2x the required amount for safe flash swap
  const hasLiquidity = reserve.gte(requiredAmount.mul(2));
  const ratio = reserve.div(requiredAmount.gt(0) ? requiredAmount : 1);

  return {
    hasLiquidity,
    reserve: reserve.toString(),
    ratio: ratio.toString()
  };
}

/**
 * Find best pair to use for flash swap
 * @param {string} debtToken - Token to borrow
 * @param {BigNumber} amount - Amount to borrow
 * @param {Object} pairs - Map of pair names to addresses
 * @param {Object} provider
 * @returns {Object|null} { pair, name } or null if no suitable pair
 */
async function findBestPair(debtToken, amount, pairs, provider) {
  const WFLOW = "0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e".toLowerCase();
  const USDF = "0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED".toLowerCase();

  const debtLower = debtToken.toLowerCase();
  let bestPair = null;
  let bestReserve = BigNumber.from(0);

  for (const [name, address] of Object.entries(pairs)) {
    try {
      const pairContract = new Contract(address, PAIR_ABI, provider);
      const [token0, token1, reserves] = await Promise.all([
        pairContract.token0(),
        pairContract.token1(),
        pairContract.getReserves()
      ]);

      const t0Lower = token0.toLowerCase();
      const t1Lower = token1.toLowerCase();

      // Check if pair has the debt token
      if (t0Lower !== debtLower && t1Lower !== debtLower) {
        continue;
      }

      const isToken0 = t0Lower === debtLower;
      const reserve = isToken0 ? BigNumber.from(reserves.reserve0) : BigNumber.from(reserves.reserve1);

      // Check if sufficient liquidity
      if (reserve.lt(amount.mul(2))) {
        console.log(`[PunchSwap] ${name}: insufficient liquidity (${reserve.toString()} < ${amount.mul(2).toString()})`);
        continue;
      }

      // Prefer pairs with more liquidity
      if (reserve.gt(bestReserve)) {
        bestReserve = reserve;
        bestPair = { pair: address, name, reserve: reserve.toString() };
      }
    } catch (err) {
      console.log(`[PunchSwap] Error checking pair ${name}: ${err.message}`);
    }
  }

  return bestPair;
}

/**
 * Calculate UniswapV2 flash swap repayment amount
 * Flash swap fee is 0.3% (borrowed * 1000 / 997 + 1)
 * @param {BigNumber} borrowedAmount
 * @returns {BigNumber}
 */
function calculateFlashSwapRepayment(borrowedAmount) {
  return borrowedAmount.mul(1000).div(997).add(1);
}

/**
 * Build liquidation params for Flash Swap path (PunchSwap V2)
 *
 * @param {Object} params
 * @param {string} params.collateralAsset - Collateral token address
 * @param {string} params.debtAsset - Debt token address
 * @param {BigNumber} params.debtAmount - Amount of debt to borrow via flash swap
 * @param {BigNumber} params.collateralAmount - Expected collateral to receive
 * @param {string} params.router - PunchSwap router address
 * @param {string} params.wflow - WFLOW address
 * @param {number} params.slippage - Slippage tolerance
 * @param {Object} params.provider - Ethers provider
 * @returns {Object} { sParamToRepayLoan, sParamToSendToReceiver, quote1, quote2, estimatedReward }
 */
async function buildFlashSwapLiquidationParams({
  collateralAsset,
  debtAsset,
  debtAmount,
  collateralAmount,
  router,
  wflow,
  slippage = 0.02,
  provider
}) {
  const isWFLOWDebt = debtAsset.toLowerCase() === wflow.toLowerCase();
  const repaymentAmount = calculateFlashSwapRepayment(debtAmount);

  console.log(`[FlashSwap] Building params - debt: ${debtAmount.toString()}, collateral: ${collateralAmount.toString()}`);
  console.log(`[FlashSwap] Flash swap repayment (with 0.3% fee): ${repaymentAmount.toString()}`);

  // Swap #1: collateral -> debt (to repay flash swap)
  const { swapParams: sParamToRepayLoan, quote: quote1 } = await buildV2SwapParams({
    fromToken: collateralAsset,
    toToken: debtAsset,
    amountIn: collateralAmount.toString(),
    router,
    slippage,
    provider
  });

  // Override amountOutMin to cover flash swap repayment
  sParamToRepayLoan.amountOutMin = repaymentAmount.toString();

  // Calculate estimated reward
  const expectedOutput = BigNumber.from(quote1.expectedOutput);
  const estimatedReward = expectedOutput.sub(repaymentAmount);

  console.log(`[FlashSwap] Expected swap output: ${expectedOutput.toString()}`);
  console.log(`[FlashSwap] Estimated reward: ${estimatedReward.toString()}`);

  if (estimatedReward.lte(0)) {
    throw new Error(`Flash swap not profitable: reward ${estimatedReward.toString()} <= 0`);
  }

  let sParamToSendToReceiver;
  let quote2 = null;

  if (isWFLOWDebt) {
    // Debt is WFLOW, reward already in WFLOW - no second swap needed
    sParamToSendToReceiver = buildEmptySwapParams();
  } else {
    // Swap #2: reward (debt token) -> WFLOW
    const result = await buildV2SwapParams({
      fromToken: debtAsset,
      toToken: wflow,
      amountIn: estimatedReward.toString(),
      router,
      slippage,
      provider
    });

    sParamToSendToReceiver = result.swapParams;
    quote2 = result.quote;

    // Contract will calculate actual reward on-chain
    sParamToSendToReceiver.amountIn = "0";
    sParamToSendToReceiver.amountOutMin = "0";
  }

  return {
    sParamToRepayLoan,
    sParamToSendToReceiver,
    quote1,
    quote2,
    estimatedReward,
    repaymentAmount
  };
}

module.exports = {
  SwapType,
  buildV2SwapParams,
  buildEmptySwapParams,
  getPairAddress,
  checkPairLiquidity,
  findBestPair,
  calculateFlashSwapRepayment,
  buildFlashSwapLiquidationParams,
  ROUTER_ABI,
  PAIR_ABI,
  FACTORY_ABI
};
