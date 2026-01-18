/**
 * MORE Liquidation Bot - Modular Version
 *
 * Uses strategy pattern for liquidation execution
 * Maintains all optimizations from the original bot
 */
const { providers, BigNumber, Wallet, Contract, utils, constants: ethersConstants } = require('ethers');
const { HttpLink } = require('apollo-link-http');
const { ApolloClient } = require('apollo-client');
const { InMemoryCache } = require('apollo-cache-inmemory');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Modular imports
const { StrategyManager, getAllStrategies, getApplicableStrategies } = require('./strategies');
const { TelegramService } = require('./services');
const { PricingService } = require('./services');
const {
  TOKENS,
  STABLEKITTY_POOLS,
  FLOWSCAN_URL,
  ABIS,
  TOKEN_DECIMALS,
  Strategy,
  STRATEGY_INFO
} = require('./constants');
const {
  shortAddr,
  formatUsd,
  isStableSwap,
  findStableKittyPool,
  sleep,
  calculateDynamicSlippage,
  calculateGasMultiplier
} = require('./utils');

// Config and queries
const config = require('../config.json');
const { usersQuery } = require('../query.js');

// State file
const STATE_FILE = path.join(__dirname, '..', 'bot_state.json');

// ABIs
const PoolAbi = require('../abis/Pool.json');
const MTokenAbi = require('../abis/MToken.json');
const MulticallAbi = require('../abis/MulticallAbi.json');
const LiquidationAbi = require('../abis/Liquidation.json');
const AaveOracleAbi = require('../abis/AaveOracle.json');

// ============================================
// DUAL RPC SYSTEM
// ============================================
const PUBLIC_RPC = 'https://mainnet.evm.nodes.onflow.org';
const TX_RPC = config.rpc_url;

let provider = new providers.JsonRpcProvider(PUBLIC_RPC);
const txProvider = new providers.JsonRpcProvider(TX_RPC);
let usingAlchemyFallback = false;

// Interfaces
const poolInterface = new utils.Interface(PoolAbi);
const mTokenInterface = new utils.Interface(MTokenAbi);

// Contracts
let multicallContract = new Contract(config.contracts.multicall, MulticallAbi, provider);
let oracleContract = new Contract(config.contracts.oracle, AaveOracleAbi, provider);

// Services
let telegramService;
let pricingService;
let strategyManager;

// Constants
const WFLOW = config.contracts.wflow;
const MIN_DEBT_USD = config.min_debt_usd || 1;
const FLASH_LOAN_PREMIUM_BPS = 5n;
const FLASH_SWAP_FEE_BPS = 30n;

// ============================================
// HOT POSITIONS & PREPARED LIQUIDATIONS
// ============================================
const hotPositions = new Map();
const preparedLiquidations = new Map();
const preparingUsers = new Set();
const PREPARED_TTL_MS = 30000;

// Position blacklist (failed liquidations)
const failedPositions = new Map();
const MAX_FAILURES_BEFORE_BLACKLIST = 3;
const BLACKLIST_TTL_MS = 5 * 60 * 1000;

// WebSocket
let wsConnection = null;
let wsReconnectAttempts = 0;
const MAX_WS_RECONNECT_ATTEMPTS = 10;
const WS_URL = config.ws_url || 'wss://mainnet.evm.nodes.onflow.org';

// ============================================
// INITIALIZATION
// ============================================
function initializeServices() {
  telegramService = new TelegramService({
    bot_token: config.bot_token,
    alert_chat_id: config.alert_chat_id,
    info_chat_id: config.info_chat_id
  });

  pricingService = new PricingService(oracleContract, provider);
  strategyManager = new StrategyManager();

  console.log(`[Init] Loaded ${strategyManager.strategies.length} strategies`);
  strategyManager.strategies.forEach(s => {
    console.log(`  ${s.priority}. ${s.name} (${s.fee}bps)`);
  });
}

function reinitializeContracts() {
  multicallContract = new Contract(config.contracts.multicall, MulticallAbi, provider);
  oracleContract = new Contract(config.contracts.oracle, AaveOracleAbi, provider);
  pricingService = new PricingService(oracleContract, provider);
  console.log('[RPC] Contracts reinitialized');
}

function switchToAlchemyFallback() {
  if (usingAlchemyFallback) return;
  console.log('[RPC] Switching reads to Alchemy (fallback)...');
  provider = new providers.JsonRpcProvider(TX_RPC);
  reinitializeContracts();
  usingAlchemyFallback = true;
}

function switchToPublicRpc() {
  if (!usingAlchemyFallback) return;
  console.log('[RPC] Switching reads back to public RPC...');
  provider = new providers.JsonRpcProvider(PUBLIC_RPC);
  reinitializeContracts();
  usingAlchemyFallback = false;
}

// ============================================
// BLACKLIST MANAGEMENT
// ============================================
function recordFailedLiquidation(user, reason) {
  const existing = failedPositions.get(user) || { failures: 0, lastAttempt: 0, reason: '' };
  failedPositions.set(user, {
    failures: existing.failures + 1,
    lastAttempt: Date.now(),
    reason
  });
}

function shouldSkipPosition(user) {
  const failed = failedPositions.get(user);
  if (!failed) return false;

  if (Date.now() - failed.lastAttempt > BLACKLIST_TTL_MS) {
    failedPositions.delete(user);
    return false;
  }

  return failed.failures >= MAX_FAILURES_BEFORE_BLACKLIST;
}

function clearFailedPosition(user) {
  failedPositions.delete(user);
}

// ============================================
// STATE MANAGEMENT
// ============================================
const loadState = () => {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading state:', err.message);
  }
  return { lastReportTime: 0 };
};

const saveState = (state) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
};

// ============================================
// SUBGRAPH FETCHER
// ============================================
const apolloFetcher = async (query) => {
  const client = new ApolloClient({
    link: new HttpLink({ uri: config.subgraph_url }),
    cache: new InMemoryCache()
  });

  return client.query({
    query: query.query,
    variables: query.variables
  });
};

// ============================================
// RETRY HELPER
// ============================================
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
      await sleep(delay);
    }
  }
  throw lastError;
}

// ============================================
// COLLATERAL CALCULATION
// ============================================
async function calculateExpectedCollateral(debtToCover, collateralAsset, debtAsset, collateralDecimals, debtDecimals) {
  const [debtPrice, collateralPrice] = await Promise.all([
    pricingService.getPrice(debtAsset),
    pricingService.getPrice(collateralAsset)
  ]);

  // Get liquidation bonus (hardcoded to 10500 = 5% bonus for now)
  const liquidationBonus = BigNumber.from(10500);

  // Aave formula: collateral = (debtToCover × debtPrice × liquidationBonus) / (collateralPrice × 10000)
  const decimalAdjustment = BigNumber.from(10).pow(collateralDecimals - debtDecimals + 8 - 8);

  const theoreticalCollateral = debtToCover
    .mul(debtPrice)
    .mul(liquidationBonus)
    .div(collateralPrice)
    .div(10000)
    .mul(decimalAdjustment);

  // Apply conservative factor (99%)
  const CONSERVATIVE_FACTOR = 99n;
  return theoreticalCollateral.mul(CONSERVATIVE_FACTOR).div(100n);
}

// ============================================
// PREPARED LIQUIDATIONS
// ============================================
function getPreparedParams(user) {
  const prepared = preparedLiquidations.get(user);
  if (!prepared) return null;
  if (Date.now() - prepared.timestamp > PREPARED_TTL_MS) {
    preparedLiquidations.delete(user);
    return null;
  }
  return prepared;
}

function cleanExpiredPrepared() {
  const now = Date.now();
  for (const [user, data] of preparedLiquidations.entries()) {
    if (now - data.timestamp > PREPARED_TTL_MS) {
      preparedLiquidations.delete(user);
    }
  }
}

// ============================================
// EXECUTE LIQUIDATION WITH STRATEGY MANAGER
// ============================================
async function executeLiquidation(context) {
  const { user, botAddress, collateralAsset, debtAsset, debtToCover, expectedCollateral,
          collateralDecimals, debtDecimals, healthFactor, debtValueUsd } = context;

  const liquidator = new Wallet(config.liquidator_key, txProvider);
  const botContract = new Contract(botAddress, LiquidationAbi, liquidator);

  // Build strategy context
  const strategyContext = {
    collateralAsset,
    debtAsset,
    user,
    debtToCover,
    expectedCollateral,
    collateralDecimals,
    debtDecimals,
    provider,
    contractAddress: botAddress,
    receiver: liquidator.address,
    eisenApiKey: config.eisen_api_key,
    punchswapRouter: config.contracts.punchswap?.router,
    slippage: calculateDynamicSlippage(debtValueUsd),
    wflow: WFLOW
  };

  // Get applicable strategies
  const applicable = getApplicableStrategies(strategyContext);
  if (applicable.length === 0) {
    console.log(`[Liquidation] No applicable strategies for ${shortAddr(user)}`);
    recordFailedLiquidation(user, 'No applicable strategies');
    return { success: false, error: 'No applicable strategies' };
  }

  console.log(`[Liquidation] ${applicable.length} strategies: ${applicable.map(s => s.name).join(', ')}`);

  // Try strategies in order
  for (const strategy of applicable) {
    console.log(`\n[Liquidation] Trying ${strategy.name}...`);

    try {
      const params = await strategy.buildParams(strategyContext);
      if (!params) {
        console.log(`[Liquidation] ${strategy.name} - Failed to build params`);
        continue;
      }

      // Get method and args
      const methodName = strategy.getContractMethod();
      const args = strategy.getMethodArgs(params);

      // Calculate gas
      const expectedProfitUsd = debtValueUsd * 0.05;
      const gasMultiplier = calculateGasMultiplier(expectedProfitUsd);
      const baseGasPrice = await txProvider.getGasPrice();
      const gasPrice = baseGasPrice.mul(gasMultiplier).div(100);

      // Simulate first
      console.log(`[Liquidation] Simulating ${methodName}...`);
      try {
        await botContract.callStatic[methodName](...args);
      } catch (simErr) {
        console.log(`[Liquidation] Simulation failed: ${simErr.message?.slice(0, 80)}`);
        continue;
      }

      // Execute
      console.log(`[Liquidation] Executing ${methodName} (gas: ${gasMultiplier/100}x)...`);
      const tx = await botContract[methodName](...args, { gasPrice, gasLimit: 2000000 });
      console.log(`[Liquidation] Tx sent: ${tx.hash}`);

      const receipt = await tx.wait();
      console.log(`[Liquidation] Tx confirmed! Gas used: ${receipt.gasUsed.toString()}`);

      // Calculate rewards
      const gasCostWei = receipt.gasUsed.mul(receipt.effectiveGasPrice);
      const gasCostFlow = Number(gasCostWei.toString()) / 1e18;
      const flowPrice = await pricingService.getPrice(WFLOW);
      const gasCostUsd = gasCostFlow * Number(flowPrice.toString()) / 1e8;

      // Get liquidator balances
      const liquidatorBalance = Number((await txProvider.getBalance(liquidator.address)).toString()) / 1e18;
      const wflowContract = new Contract(WFLOW, ['function balanceOf(address) view returns (uint256)'], txProvider);
      const liquidatorWflowBalance = Number((await wflowContract.balanceOf(liquidator.address)).toString()) / 1e18;

      // Notify success
      await telegramService.notifyLiquidationSuccess({
        user,
        healthFactor: (Number(healthFactor.toString()) / 1e18).toFixed(4),
        debtCovered: debtToCover.toString(),
        debtValueUsd,
        collateralSymbol: shortAddr(collateralAsset),
        strategy: strategy.name,
        txHash: receipt.transactionHash,
        rewardDisplay: params.estimatedReward ? `~${formatUsd(Number(params.estimatedReward.toString()) / 1e6)}` : 'N/A',
        gasCostFlow,
        gasCostUsd,
        liquidatorBalance,
        liquidatorWflowBalance
      });

      // Clear from blacklist on success
      clearFailedPosition(user);

      return { success: true, txHash: receipt.transactionHash, strategy: strategy.name };

    } catch (err) {
      console.log(`[Liquidation] ${strategy.name} failed: ${err.message?.slice(0, 80)}`);
    }
  }

  // All strategies failed
  recordFailedLiquidation(user, 'All strategies failed');
  await telegramService.notifyLiquidationFailure({
    user,
    strategy: 'ALL',
    error: 'All strategies failed'
  });

  return { success: false, error: 'All strategies failed' };
}

// ============================================
// MAIN SCAN LOOP
// ============================================
async function main() {
  // Pre-warm price cache
  try {
    await pricingService.warmCache([WFLOW]);
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
      variables: { first, skip }
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

  // 2. Check health factors via multicall
  const userChunkSize = 50;
  let allUsersHealthRes = [];

  for (const pool of config.pools) {
    for (let i = 0; i < allUsers.length; i += userChunkSize) {
      const userChunk = allUsers.slice(i, i + userChunkSize);
      const usersHealthReq = userChunk.map(user => ({
        target: pool,
        callData: poolInterface.encodeFunctionData('getUserAccountData', [user.id])
      }));

      if (usersHealthReq.length > 0) {
        const chunkHealthRes = await retryWithBackoff(
          () => multicallContract.callStatic.aggregate(usersHealthReq),
          3, 1000, 'multicall-health'
        );

        const userWithHealth = chunkHealthRes.returnData.map((userHealth, ind) => {
          const detailedInfo = poolInterface.decodeFunctionResult('getUserAccountData', userHealth);
          return {
            pool,
            block: chunkHealthRes.blockNumber,
            user: allUsers[ind + i].id,
            healthFactor: BigNumber.from(detailedInfo.healthFactor),
            totalDebtBase: BigNumber.from(detailedInfo.totalDebtBase)
          };
        });

        allUsersHealthRes = allUsersHealthRes.concat(userWithHealth);
        console.log(`Pool ${shortAddr(pool)}: processed ${userChunk.length} users`);
      }
    }
  }

  // 3. Filter unhealthy users (HF < 1) sorted by debt size
  const unhealthyUsers = allUsersHealthRes.filter(
    u => u.healthFactor.lte(ethersConstants.WeiPerEther) && u.healthFactor.gt(0)
  ).sort((a, b) => {
    const debtA = Number(a.totalDebtBase.toString());
    const debtB = Number(b.totalDebtBase.toString());
    return debtB - debtA;
  });

  // Filter users close to liquidation (1.0 <= HF < 1.10)
  const wideUnhealthyUsers = allUsersHealthRes.filter(u => {
    if (!u.healthFactor.lt(ethersConstants.WeiPerEther.mul(110).div(100))) return false;
    if (!u.healthFactor.gte(ethersConstants.WeiPerEther)) return false;
    const debtUsd = Number(u.totalDebtBase.toString()) / 1e8;
    return debtUsd >= MIN_DEBT_USD;
  });

  // Update hot positions tracker
  for (const hotUser of wideUnhealthyUsers) {
    const hfFloat = Number(hotUser.healthFactor.toString()) / 1e18;
    const debtUsd = Number(hotUser.totalDebtBase.toString()) / 1e8;
    const priceDropPct = (1 - (1.0 / hfFloat)) * 100;

    hotPositions.set(hotUser.user, {
      hf: hfFloat,
      debtUsd,
      priceDropToLiquidate: priceDropPct.toFixed(2),
      lastUpdate: Date.now()
    });
  }

  // Clean old entries
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  for (const [user, data] of hotPositions.entries()) {
    if (data.lastUpdate < fiveMinutesAgo) {
      hotPositions.delete(user);
    }
  }

  console.log(`[HotPositions] Tracking ${hotPositions.size} positions near liquidation`);
  console.log(`Checking ${unhealthyUsers.length} potentially liquidatable users...`);

  // 4. Execute liquidations
  const liquidator = new Wallet(config.liquidator_key, txProvider);

  for (const unhealthyUser of unhealthyUsers) {
    const botInfo = config.bots[unhealthyUser.pool];
    if (!botInfo) {
      console.log(`No bot config for pool ${unhealthyUser.pool}`);
      continue;
    }

    // Fetch user's token balances
    const mTokenRequest = [];
    botInfo.mTokens.forEach(mToken => {
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData('balanceOf', [unhealthyUser.user])
      });
      mTokenRequest.push({
        target: mToken,
        callData: mTokenInterface.encodeFunctionData('UNDERLYING_ASSET_ADDRESS', [])
      });
    });

    botInfo.dTokens.forEach(dToken => {
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData('balanceOf', [unhealthyUser.user])
      });
      mTokenRequest.push({
        target: dToken,
        callData: mTokenInterface.encodeFunctionData('UNDERLYING_ASSET_ADDRESS', [])
      });
    });

    const tokenRes = await retryWithBackoff(
      () => multicallContract.callStatic.aggregate(mTokenRequest),
      3, 1000, 'multicall-tokens'
    );

    const mInfos = [];
    const dInfos = [];
    const tokensWithUnderlying = [];

    const tokenInfos = tokenRes[1].map((res, ind) => ({
      info: mTokenInterface.decodeFunctionResult(
        ind % 2 === 0 ? 'balanceOf' : 'UNDERLYING_ASSET_ADDRESS',
        res
      )
    }));

    for (let ii = 0; ii < tokenInfos.length; ii++) {
      const selInd = ii % 2;
      if (selInd === 0) {
        const detailedInfo = tokenInfos[ii].info[0];
        if (detailedInfo.gt(0)) {
          if (ii < botInfo.mTokens.length * 2) {
            mInfos.push({ token: tokenInfos[ii + 1].info, amount: BigNumber.from(detailedInfo) });
          } else {
            dInfos.push({ token: tokenInfos[ii + 1].info, amount: BigNumber.from(detailedInfo) });
          }
        }
      } else if (ii < botInfo.mTokens.length * 2) {
        const detailedInfo = tokenInfos[ii].info[0].toLowerCase();
        if (!tokensWithUnderlying.find(t => t.token === detailedInfo)) {
          tokensWithUnderlying.push({
            token: detailedInfo,
            mtoken: botInfo.mTokens[Math.floor(ii / 2)]
          });
        }
      }
    }

    // Skip if no collateral or debt
    if (mInfos.length === 0 || dInfos.length === 0) {
      console.log(`No collateral or debt for user ${unhealthyUser.user}`);
      continue;
    }

    const debtAsset = dInfos[0].token[0];
    const debtMToken = tokensWithUnderlying.find(t => t.token === debtAsset.toLowerCase());
    if (!debtMToken) continue;

    // Get debt info
    const debtContract = new Contract(debtAsset, MTokenAbi, provider);
    const [debtBalanceInmToken, debtDecimals] = await Promise.all([
      debtContract.balanceOf(debtMToken.mtoken),
      debtContract.decimals()
    ]);
    const userDebt = dInfos[0].amount;

    // Calculate debt to cover (50% max + buffer)
    const CLOSE_FACTOR = 50n;
    const maxLiquidatable = userDebt.mul(CLOSE_FACTOR).div(100n);
    let debtToCover = userDebt.gt(debtBalanceInmToken) ? debtBalanceInmToken : userDebt;
    debtToCover = debtToCover.gt(maxLiquidatable) ? maxLiquidatable : debtToCover;

    const INTEREST_BUFFER_BPS = 10n;
    debtToCover = debtToCover.mul(10000n + INTEREST_BUFFER_BPS).div(10000n);

    if (debtToCover.lte(0)) continue;

    // Skip dust
    const debtValueUsd = Number(unhealthyUser.totalDebtBase.toString()) / 1e8;
    if (debtValueUsd < MIN_DEBT_USD) {
      console.log(`Skipping dust: ${shortAddr(unhealthyUser.user)} ($${debtValueUsd.toFixed(2)})`);
      continue;
    }

    // Skip blacklisted positions
    if (shouldSkipPosition(unhealthyUser.user)) {
      const failed = failedPositions.get(unhealthyUser.user);
      console.log(`⏭️ SKIPPING blacklisted: ${shortAddr(unhealthyUser.user)} (${failed.failures}x: ${failed.reason})`);
      continue;
    }

    // Notify target found
    const hf = (unhealthyUser.healthFactor.toString() / 1e18).toFixed(4);
    await telegramService.notifyTargetFound({
      user: unhealthyUser.user,
      healthFactor: hf,
      debtValueUsd
    });

    // Get collateral info
    const collateralAsset = mInfos[0].token[0];
    const collateralContract = new Contract(collateralAsset, MTokenAbi, provider);
    const collateralDecimals = await collateralContract.decimals();

    // Re-check health factor
    const poolContract = new Contract(unhealthyUser.pool, PoolAbi, provider);
    const freshData = await poolContract.getUserAccountData(unhealthyUser.user);
    const freshHF = BigNumber.from(freshData.healthFactor);

    if (freshHF.gt(ethersConstants.WeiPerEther)) {
      console.log(`[Liquidation] User no longer liquidatable (HF > 1), skipping`);
      await telegramService.sendInfo(`⏭️ Skipped ${shortAddr(unhealthyUser.user)} - HF recovered to ${(Number(freshHF.toString()) / 1e18).toFixed(4)}`);
      continue;
    }

    // Calculate expected collateral
    const flashLoanPremium = debtToCover.mul(FLASH_LOAN_PREMIUM_BPS).div(10000n);
    const totalNeeded = debtToCover.add(flashLoanPremium);
    const expectedCollateral = await calculateExpectedCollateral(
      totalNeeded,
      collateralAsset,
      debtAsset,
      collateralDecimals,
      debtDecimals
    );

    // Execute liquidation
    const result = await executeLiquidation({
      user: unhealthyUser.user,
      botAddress: botInfo.bot,
      collateralAsset,
      debtAsset,
      debtToCover,
      expectedCollateral,
      collateralDecimals,
      debtDecimals,
      healthFactor: unhealthyUser.healthFactor,
      debtValueUsd
    });

    console.log(`[Liquidation] Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  }

  // Clean expired prepared params
  cleanExpiredPrepared();
}

// ============================================
// WEBSOCKET FOR REAL-TIME BLOCK UPDATES
// ============================================
async function handleNewBlock(blockNumber) {
  // Quick check of hot positions on new blocks
  if (hotPositions.size === 0) return;

  console.log(`[Block ${blockNumber}] Quick check of ${hotPositions.size} hot positions...`);

  // For now, just trigger main scan if we have hot positions
  // This can be optimized later to only check specific positions
}

function connectWebSocket() {
  console.log(`[WebSocket] Connecting to ${WS_URL}...`);
  wsConnection = new WebSocket(WS_URL);

  wsConnection.on('open', () => {
    console.log('[WebSocket] Connected!');
    wsReconnectAttempts = 0;
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
        handleNewBlock(blockNumber).catch(() => {});
      } else if (msg.result && msg.id === 1) {
        console.log(`[WebSocket] Subscribed to newHeads (ID: ${msg.result})`);
      }
    } catch (err) {
      console.error(`[WebSocket] Message parse error: ${err.message}`);
    }
  });

  wsConnection.on('close', () => {
    console.log('[WebSocket] Connection closed');
    wsConnection = null;

    if (wsReconnectAttempts < MAX_WS_RECONNECT_ATTEMPTS) {
      wsReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 30000);
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${wsReconnectAttempts})`);
      setTimeout(connectWebSocket, delay);
    }
  });

  wsConnection.on('error', (err) => {
    console.error(`[WebSocket] Error: ${err.message}`);
  });
}

// ============================================
// MAIN LOOP
// ============================================
async function runLoop() {
  // Initialize services
  initializeServices();

  const intervalMs = (config.loop_interval_seconds || 60) * 1000;
  const fallbackIntervalMs = 3000;
  console.log(`Starting bot in loop mode (full scan: ${intervalMs / 1000}s)`);

  // Connect WebSocket
  try {
    connectWebSocket();
    await telegramService.notifyBotStarted({
      mode: 'WebSocket',
      loopInterval: intervalMs / 1000,
      wsConnected: true
    });
  } catch (err) {
    console.log(`[WebSocket] Failed to connect: ${err.message}`);
    await telegramService.notifyBotStarted({
      mode: 'Polling',
      loopInterval: intervalMs / 1000,
      wsConnected: false
    });
  }

  let lastFullScan = 0;
  let consecutiveErrors = 0;
  const MAX_SILENT_ERRORS = 3;

  while (true) {
    try {
      const now = Date.now();

      if (now - lastFullScan >= intervalMs) {
        await main();
        lastFullScan = now;
      }

      if (consecutiveErrors > 0) {
        console.log(`[Recovery] Bot recovered after ${consecutiveErrors} errors`);
        consecutiveErrors = 0;
        if (usingAlchemyFallback) {
          switchToPublicRpc();
        }
      }
    } catch (err) {
      consecutiveErrors++;
      const errorMsg = err.message?.slice(0, 100) || 'Unknown error';
      console.error(`Loop error (${consecutiveErrors}): ${errorMsg}`);

      const isNetworkError = errorMsg.includes('NETWORK_ERROR') ||
                             errorMsg.includes('could not detect network') ||
                             errorMsg.includes('ECONNREFUSED');

      if (isNetworkError && consecutiveErrors >= 2 && !usingAlchemyFallback) {
        switchToAlchemyFallback();
        await telegramService.sendAlert(`🔄 <b>RPC Fallback</b>\n\nSwitched reads to Alchemy`);
      }

      if (consecutiveErrors >= MAX_SILENT_ERRORS) {
        await telegramService.sendAlert(`⚠️ <b>Bot Error</b> (${consecutiveErrors}x)\n\n<code>${errorMsg}</code>`);
      }
    }

    await sleep(wsConnection ? 10000 : fallbackIntervalMs);
  }
}

// Start the bot
runLoop().catch(console.error);
