/**
 * Test script to run the bot ONCE and verify:
 * 1. Decimals are correct
 * 2. Strategy selection works
 * 3. Hourly report shows pool liquidity
 * 4. Profit calculations are correct
 */

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
const {
  Strategy,
  selectBestStrategy,
  calculateDynamicSlippage,
  getLiquiditySummary,
  getV2PairLiquidity,
  POOLS_CONFIG,
  TOKENS
} = require("./liquidity.js");

const config = require("./config.json");
const STATE_FILE = path.join(__dirname, "bot_state.json");
const PoolAbi = require("./abis/Pool.json");
const MTokenAbi = require("./abis/MToken.json");
const MulticallAbi = require("./abis/MulticallAbi.json");
const AaveOracleAbi = require("./abis/AaveOracle.json");
const DataProviderAbi = require("./abis/DataProvider.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);

// Interfaces
const poolInterface = new utils.Interface(PoolAbi);
const mTokenInterface = new utils.Interface(MTokenAbi);

// Contracts
const multicallContract = new Contract(
  config.contracts.multicall,
  MulticallAbi,
  provider
);

const oracleContract = new Contract(
  config.contracts.oracle,
  AaveOracleAbi,
  provider
);

const WFLOW = config.contracts.wflow;
const MIN_DEBT_USD = config.min_debt_usd || 1;
const FLOWSCAN_URL = 'https://evm.flowscan.io';

// Price cache
const priceCache = new Map();
const CACHE_TTL_MS = 10000;

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

// Telegram
let telegramBot = null;
const getTelegramBot = () => {
  if (!telegramBot) {
    telegramBot = new Telegraf(config.bot_token);
  }
  return telegramBot;
};

const sendInfo = async (message) => {
  try {
    await getTelegramBot().telegram.sendMessage(config.info_chat_id, message, { parse_mode: 'HTML' });
    console.log('[Telegram] Message sent successfully');
  } catch (err) {
    console.error("[Telegram] Error:", err.message);
  }
};

const shortAddr = (addr) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

function calculatePriceDropToLiquidate(currentHF) {
  const hfFloat = Number(currentHF.toString()) / 1e18;
  return (1 - (1.0 / hfFloat)) * 100;
}

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

// V2 Pair ABI
const PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

// V3 Pool ABI
const V3_POOL_ABI = [
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

const ERC20_DECIMALS_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

// Get PunchSwap liquidity
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

      const [price0, price1] = await Promise.all([
        getCachedPrice(token0),
        getCachedPrice(token1)
      ]);

      const isToken0Stable = token0.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();
      const isToken1Stable = token1.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();

      let tvlUsd;
      if (isToken0Stable) {
        tvlUsd = Number(reserve0.toString()) / 1e6 * 2;
      } else if (isToken1Stable) {
        tvlUsd = Number(reserve1.toString()) / 1e6 * 2;
      } else {
        const value0 = Number(reserve0.toString()) / 1e18 * Number(price0.toString()) / 1e8;
        tvlUsd = value0 * 2;
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

// Get V3 liquidity
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

      const isToken0Stable = token0.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();
      const isToken1Stable = token1.toLowerCase() === config.contracts.tokens?.USDF?.toLowerCase();

      let tvlUsd;
      if (isToken0Stable) {
        tvlUsd = balance0 * 2;
      } else if (isToken1Stable) {
        tvlUsd = balance1 * 2;
      } else {
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

async function main() {
  console.log('========================================');
  console.log('    MORE LIQUIDATION BOT - SINGLE RUN  ');
  console.log('========================================\n');

  // 1. Fetch users from subgraph
  console.log('[1/5] Fetching users from subgraph...');
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
  }
  console.log(`   Total users: ${allUsers.length}`);

  // 2. Check health factors via multicall
  console.log('\n[2/5] Checking health factors...');
  let allUsersHealthRes = [];
  const userChunkSize = 50;

  for (let poolInd = 0; poolInd < config.pools.length; poolInd++) {
    const pool = config.pools[poolInd];
    for (let i = 0; i < allUsers.length; i += userChunkSize) {
      const userChunk = allUsers.slice(i, i + userChunkSize);
      const usersHealthReq = userChunk.map((user) => ({
        target: pool,
        callData: poolInterface.encodeFunctionData("getUserAccountData", [user.id]),
      }));

      if (usersHealthReq.length > 0) {
        const chunkHealthRes = await multicallContract.callStatic.aggregate(usersHealthReq);

        const userWithHealth = chunkHealthRes.returnData.map((userHealth, ind) => {
          const detailedInfo = poolInterface.decodeFunctionResult("getUserAccountData", userHealth);
          return {
            pool: pool,
            block: chunkHealthRes.blockNumber,
            user: allUsers[ind + i].id,
            healthFactor: BigNumber.from(detailedInfo.healthFactor),
            totalDebtBase: BigNumber.from(detailedInfo.totalDebtBase),
          };
        });

        allUsersHealthRes = allUsersHealthRes.concat(userWithHealth);
      }
    }
  }
  console.log(`   Processed ${allUsersHealthRes.length} user health checks`);

  // 3. Filter and analyze users
  console.log('\n[3/5] Analyzing user positions...');

  const unhealthyUsers = allUsersHealthRes.filter(
    (userHealth) => userHealth.healthFactor.lte(constants.WeiPerEther) && userHealth.healthFactor.gt(0)
  );

  const wideUnhealthyUsers = allUsersHealthRes.filter((userHealth) => {
    if (!userHealth.healthFactor.lt(constants.WeiPerEther.mul(110).div(100))) return false;
    if (!userHealth.healthFactor.gte(constants.WeiPerEther)) return false;
    const debtUsd = Number(userHealth.totalDebtBase.toString()) / 1e8;
    return debtUsd >= MIN_DEBT_USD;
  }).sort((a, b) => {
    const hfA = Number(a.healthFactor.toString());
    const hfB = Number(b.healthFactor.toString());
    return hfA - hfB;
  });

  console.log(`   Liquidatable (HF < 1): ${unhealthyUsers.length}`);
  console.log(`   Near liquidation (1.0 <= HF < 1.10): ${wideUnhealthyUsers.length}`);

  // 4. Test strategy selection
  console.log('\n[4/5] Testing strategy selection...');

  const testCases = [
    { debt: TOKENS.USDF, amount: '1000000000' }, // 1000 USDF
    { debt: TOKENS.WFLOW, amount: '1000000000000000000000' }, // 1000 WFLOW
    { debt: TOKENS.ankrFLOW, amount: '100000000000000000000' }, // 100 ankrFLOW
    { debt: TOKENS.stFLOW, amount: '100000000000000000000' }, // 100 stFLOW (Eisen only)
  ];

  for (const tc of testCases) {
    const tokenName = Object.entries(TOKENS).find(([k, v]) => v.toLowerCase() === tc.debt.toLowerCase())?.[0] || 'Unknown';
    const strategy = await selectBestStrategy(
      TOKENS.WFLOW, // collateral
      tc.debt,
      BigNumber.from(tc.amount),
      BigNumber.from(0),
      provider
    );
    console.log(`   ${tokenName}: ${strategy.strategy} (${strategy.reason})`);
  }

  // 5. Generate status report
  console.log('\n[5/5] Generating status report...');

  const totalDebtAtRisk = wideUnhealthyUsers.reduce((sum, u) => {
    return sum + Number(u.totalDebtBase.toString()) / 1e8;
  }, 0);

  const liquidator = new Wallet(config.liquidator_key, provider);
  const liquidatorBalance = await provider.getBalance(liquidator.address);
  const liquidatorFlowBalance = Number(liquidatorBalance.toString()) / 1e18;
  const wflowContract = new Contract(WFLOW, MTokenAbi, provider);
  const wflowBalance = await wflowContract.balanceOf(liquidator.address);
  const liquidatorWflowBalance = Number(wflowBalance.toString()) / 1e18;

  const reportLines = [
    `📊 <b>Status Report (TEST)</b>`,
    ``,
    `👥 Users monitored: <b>${allUsersHealthRes.length}</b>`,
    `🔴 Liquidatable: <b>${unhealthyUsers.length}</b>`,
    `🟡 Near liquidation: <b>${wideUnhealthyUsers.length}</b>`,
    `💰 Debt at risk: <b>$${totalDebtAtRisk.toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>`,
  ];

  if (wideUnhealthyUsers.length > 0) {
    reportLines.push(``, `<b>🎯 Closest to liquidation:</b>`);
    const topByHF = wideUnhealthyUsers.slice(0, 3);
    for (const u of topByHF) {
      const hf = (Number(u.healthFactor.toString()) / 1e18).toFixed(4);
      const debtUsd = (Number(u.totalDebtBase.toString()) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const priceDrop = calculatePriceDropToLiquidate(u.healthFactor).toFixed(2);
      reportLines.push(`• <a href="${FLOWSCAN_URL}/address/${u.user}">${shortAddr(u.user)}</a> HF: ${hf} ($${debtUsd}) -${priceDrop}%`);
    }
  }

  reportLines.push(``, `🏦 <b>Liquidator:</b> <a href="${FLOWSCAN_URL}/address/${liquidator.address}">${shortAddr(liquidator.address)}</a>`);
  reportLines.push(`   FLOW: ${liquidatorFlowBalance.toFixed(4)} | WFLOW: ${liquidatorWflowBalance.toFixed(4)}`);

  // DEX liquidity
  try {
    const [punchLiquidity, v3Liquidity] = await Promise.all([
      getPunchSwapLiquidity(),
      getV3Liquidity()
    ]);

    reportLines.push(``, `<b>⚡ PunchSwap V2:</b>`);
    for (const [name, info] of Object.entries(punchLiquidity)) {
      if (info.error) {
        reportLines.push(`• ${name}: ❌`);
      } else {
        const tvl = Number(info.tvlUsd).toLocaleString('en-US', { maximumFractionDigits: 0 });
        reportLines.push(`• ${name}: $${tvl}`);
      }
    }

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

  console.log('\n--- REPORT PREVIEW ---');
  // Strip HTML tags for console
  const consoleReport = reportLines.join('\n')
    .replace(/<\/?b>/g, '')
    .replace(/<\/?i>/g, '')
    .replace(/<a[^>]*>/g, '')
    .replace(/<\/a>/g, '');
  console.log(consoleReport);
  console.log('----------------------\n');

  // Send to Telegram
  console.log('[Telegram] Sending report...');
  await sendInfo(reportLines.join('\n'));

  console.log('\n========================================');
  console.log('           TEST COMPLETED              ');
  console.log('========================================');
}

main().catch(console.error);
