/**
 * Encoding utilities for swap params and liquidation params
 */
const { utils, constants, BigNumber } = require('ethers');
const { SwapType, ABIS, STABLEKITTY_POOLS } = require('../constants');

/**
 * Build empty swap params (for skipping second swap)
 * Contract will send reward directly in debt token
 */
function buildEmptySwapParams() {
  return {
    swapType: SwapType.V2,
    router: constants.AddressZero,
    path: '0x',
    amountIn: '0',
    amountOutMin: '0',
    adapters: []
  };
}

/**
 * Build V2 swap params (PunchSwap style)
 */
function buildV2SwapParams(fromToken, toToken, amountIn, minAmountOut, router) {
  const path = [fromToken, toToken];
  const encodedPath = utils.defaultAbiCoder.encode(['address[]'], [path]);

  return {
    swapType: SwapType.V2,
    router: router,
    path: encodedPath,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build V2 multi-hop swap params
 */
function buildV2MultiHopSwapParams(path, amountIn, minAmountOut, router) {
  const encodedPath = utils.defaultAbiCoder.encode(['address[]'], [path]);

  return {
    swapType: SwapType.V2,
    router: router,
    path: encodedPath,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build V3 swap params
 */
function buildV3SwapParams(fromToken, toToken, fee, amountIn, minAmountOut, router) {
  // V3 path encoding: token0 + fee + token1
  const encodedPath = utils.solidityPack(
    ['address', 'uint24', 'address'],
    [fromToken, fee, toToken]
  );

  return {
    swapType: SwapType.V3,
    router: router,
    path: encodedPath,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build StableKitty swap params (Curve-style)
 */
function buildStableKittySwapParams(pool, amountIn, minAmountOut, receiver) {
  const iface = new utils.Interface(ABIS.STABLEKITTY);
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
    swapType: SwapType.ApiAggregator, // Works with any calldata
    router: pool.address,
    path: path,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build Eisen/API aggregator swap params
 */
function buildApiSwapParams(routerAddress, calldata, amountIn, minAmountOut) {
  return {
    swapType: SwapType.ApiAggregator,
    router: routerAddress,
    path: calldata,
    amountIn: amountIn.toString(),
    amountOutMin: minAmountOut.toString(),
    adapters: []
  };
}

/**
 * Build liquidation params
 */
function buildLiquidationParams(collateralAsset, debtAsset, user, amount, debtToCover = null) {
  return {
    collateralAsset,
    debtAsset,
    user,
    amount: amount.toString(),
    transferAmount: '0',
    debtToCover: debtToCover ? debtToCover.toString() : constants.MaxUint256.toString(),
  };
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

module.exports = {
  buildEmptySwapParams,
  buildV2SwapParams,
  buildV2MultiHopSwapParams,
  buildV3SwapParams,
  buildStableKittySwapParams,
  buildApiSwapParams,
  buildLiquidationParams,
  findStableKittyPool,
};
