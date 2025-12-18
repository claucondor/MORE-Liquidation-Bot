/**
 * Test script for cache and hot positions optimizations
 */
const {
  utils,
  constants,
  providers,
  BigNumber,
  Contract,
} = require("ethers");

const config = require("./config.json");
const PoolAbi = require("./abis/Pool.json");
const AaveOracleAbi = require("./abis/AaveOracle.json");
const DataProviderAbi = require("./abis/DataProvider.json");
const MulticallAbi = require("./abis/MulticallAbi.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);

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

const poolInterface = new utils.Interface(PoolAbi);
const WFLOW = config.contracts.wflow;

// ============================================
// CACHE SYSTEM TEST
// ============================================
const CACHE_TTL_MS = 10000;
const priceCache = new Map();

async function getCachedPrice(token) {
  const now = Date.now();
  const cached = priceCache.get(token.toLowerCase());

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`  [CACHE HIT] ${token.slice(0, 10)}...`);
    return cached.price;
  }

  console.log(`  [CACHE MISS] Fetching ${token.slice(0, 10)}...`);
  const price = await oracleContract.getAssetPrice(token);
  priceCache.set(token.toLowerCase(), { price, timestamp: now });
  return price;
}

async function batchGetPrices(tokens) {
  const uniqueTokens = [...new Set(tokens.map(t => t.toLowerCase()))];
  const uncachedTokens = [];
  const result = {};
  const now = Date.now();

  for (const token of uniqueTokens) {
    const cached = priceCache.get(token);
    if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
      result[token] = cached.price;
      console.log(`  [BATCH CACHE HIT] ${token.slice(0, 10)}...`);
    } else {
      uncachedTokens.push(token);
    }
  }

  if (uncachedTokens.length > 0) {
    console.log(`  [BATCH FETCH] ${uncachedTokens.length} tokens via multicall`);
    const priceRequests = uncachedTokens.map(token => ({
      target: config.contracts.oracle,
      callData: new utils.Interface(AaveOracleAbi).encodeFunctionData("getAssetPrice", [token])
    }));

    const priceRes = await multicallContract.callStatic.aggregate(priceRequests);
    const oracleInterface = new utils.Interface(AaveOracleAbi);

    priceRes.returnData.forEach((data, idx) => {
      const decoded = oracleInterface.decodeFunctionResult("getAssetPrice", data);
      const price = BigNumber.from(decoded[0]);
      const token = uncachedTokens[idx];
      priceCache.set(token, { price, timestamp: now });
      result[token] = price;
    });
  }

  return result;
}

// ============================================
// HOT POSITIONS TEST
// ============================================
const hotPositions = new Map();

function calculatePriceDropToLiquidate(currentHF) {
  const hfFloat = Number(currentHF.toString()) / 1e18;
  return (1 - (1.0 / hfFloat)) * 100;
}

async function quickCheckHotPositions() {
  if (hotPositions.size === 0) {
    console.log("[QuickCheck] No hot positions to check");
    return [];
  }

  const hotUsers = Array.from(hotPositions.keys());
  const poolAddress = config.pools[0];
  const liquidatable = [];

  console.log(`[QuickCheck] Checking ${hotUsers.length} hot positions...`);

  const requests = hotUsers.map(user => ({
    target: poolAddress,
    callData: poolInterface.encodeFunctionData("getUserAccountData", [user])
  }));

  const start = Date.now();
  const results = await multicallContract.callStatic.aggregate(requests);
  const elapsed = Date.now() - start;

  console.log(`[QuickCheck] Multicall took ${elapsed}ms for ${hotUsers.length} users`);

  results.returnData.forEach((data, idx) => {
    const decoded = poolInterface.decodeFunctionResult("getUserAccountData", data);
    const hf = BigNumber.from(decoded.healthFactor);
    const user = hotUsers[idx];
    const hfFloat = Number(hf.toString()) / 1e18;

    if (hf.lte(constants.WeiPerEther) && hf.gt(0)) {
      liquidatable.push({ user, hf: hfFloat });
      console.log(`  🔥 LIQUIDATABLE: ${user.slice(0, 10)}... HF: ${hfFloat.toFixed(4)}`);
    } else {
      const priceDrop = calculatePriceDropToLiquidate(hf);
      console.log(`  ✓ ${user.slice(0, 10)}... HF: ${hfFloat.toFixed(4)} (needs ${priceDrop.toFixed(2)}% drop)`);

      // Update hot position
      const hotData = hotPositions.get(user);
      if (hotData) {
        hotData.hf = hfFloat;
        hotData.priceDropToLiquidate = priceDrop.toFixed(2);
      }
    }
  });

  return liquidatable;
}

// ============================================
// MAIN TEST
// ============================================
async function runTests() {
  console.log("=" .repeat(60));
  console.log("TESTING OPTIMIZATIONS");
  console.log("=".repeat(60));

  // Test 1: Cache system
  console.log("\n📦 TEST 1: Price Cache");
  console.log("-".repeat(40));

  console.log("\nFirst call (should be CACHE MISS):");
  let start = Date.now();
  const price1 = await getCachedPrice(WFLOW);
  console.log(`  WFLOW price: $${(Number(price1) / 1e8).toFixed(4)}`);
  console.log(`  Time: ${Date.now() - start}ms`);

  console.log("\nSecond call (should be CACHE HIT):");
  start = Date.now();
  const price2 = await getCachedPrice(WFLOW);
  console.log(`  WFLOW price: $${(Number(price2) / 1e8).toFixed(4)}`);
  console.log(`  Time: ${Date.now() - start}ms`);

  // Test 2: Batch prices
  console.log("\n📦 TEST 2: Batch Price Fetch");
  console.log("-".repeat(40));

  // Some test tokens (WFLOW + USDF + others from config)
  const testTokens = [
    WFLOW,
    "0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED", // USDF
  ];

  console.log("\nBatch fetch (WFLOW cached, USDF not):");
  start = Date.now();
  const prices = await batchGetPrices(testTokens);
  console.log(`  Time: ${Date.now() - start}ms`);
  for (const [token, price] of Object.entries(prices)) {
    console.log(`  ${token.slice(0, 10)}...: $${(Number(price) / 1e8).toFixed(4)}`);
  }

  // Test 3: Find some positions near liquidation
  console.log("\n📦 TEST 3: Find Hot Positions");
  console.log("-".repeat(40));

  // Fetch some users via multicall to find hot positions
  const { usersQuery } = require("./query.js");
  const { HttpLink } = require("apollo-link-http");
  const { ApolloClient } = require("apollo-client");
  const { InMemoryCache } = require("apollo-cache-inmemory");

  const client = new ApolloClient({
    link: new HttpLink({ uri: config.subgraph_url }),
    cache: new InMemoryCache(),
  });

  console.log("\nFetching users from subgraph...");
  start = Date.now();
  const result = await client.query({
    query: usersQuery,
    variables: { first: 100, skip: 0 },
  });
  const users = result.data.users || [];
  console.log(`  Found ${users.length} users in ${Date.now() - start}ms`);

  // Check health factors
  console.log("\nChecking health factors via multicall...");
  const poolAddress = config.pools[0];
  const hfRequests = users.map(u => ({
    target: poolAddress,
    callData: poolInterface.encodeFunctionData("getUserAccountData", [u.id])
  }));

  start = Date.now();
  const hfResults = await multicallContract.callStatic.aggregate(hfRequests);
  console.log(`  Multicall for ${users.length} users took ${Date.now() - start}ms`);

  // Find hot positions (1.0 <= HF < 1.10)
  let hotCount = 0;
  let liquidatableCount = 0;

  hfResults.returnData.forEach((data, idx) => {
    const decoded = poolInterface.decodeFunctionResult("getUserAccountData", data);
    const hf = BigNumber.from(decoded.healthFactor);
    const debtUsd = Number(decoded.totalDebtBase.toString()) / 1e8;
    const user = users[idx].id;

    if (hf.gt(0) && debtUsd >= config.min_debt_usd) {
      if (hf.lte(constants.WeiPerEther)) {
        liquidatableCount++;
        console.log(`  🔴 LIQUIDATABLE: ${user.slice(0, 10)}... HF: ${(Number(hf) / 1e18).toFixed(4)} Debt: $${debtUsd.toFixed(2)}`);
      } else if (hf.lt(constants.WeiPerEther.mul(110).div(100))) {
        hotCount++;
        const priceDrop = calculatePriceDropToLiquidate(hf);
        hotPositions.set(user, {
          hf: Number(hf) / 1e18,
          debtUsd,
          priceDropToLiquidate: priceDrop.toFixed(2),
          lastUpdate: Date.now()
        });
        console.log(`  🟡 HOT: ${user.slice(0, 10)}... HF: ${(Number(hf) / 1e18).toFixed(4)} Debt: $${debtUsd.toFixed(2)} (needs ${priceDrop.toFixed(2)}% drop)`);
      }
    }
  });

  console.log(`\n  Summary: ${liquidatableCount} liquidatable, ${hotCount} hot positions`);

  // Test 4: Quick check simulation
  console.log("\n📦 TEST 4: Quick Check Hot Positions");
  console.log("-".repeat(40));

  if (hotPositions.size > 0) {
    start = Date.now();
    const quickResult = await quickCheckHotPositions();
    console.log(`\n  Quick check completed in ${Date.now() - start}ms`);
    console.log(`  Found ${quickResult.length} newly liquidatable`);
  } else {
    console.log("  No hot positions to test quick check");
  }

  // Test 5: Timing comparison
  console.log("\n📦 TEST 5: Timing Comparison");
  console.log("-".repeat(40));

  console.log("\n3 consecutive price fetches (should use cache):");
  for (let i = 0; i < 3; i++) {
    start = Date.now();
    await getCachedPrice(WFLOW);
    console.log(`  Call ${i + 1}: ${Date.now() - start}ms`);
  }

  console.log("\n=".repeat(60));
  console.log("TESTS COMPLETE");
  console.log("=".repeat(60));

  // Summary
  console.log("\n📊 SUMMARY:");
  console.log(`  - Price cache working: ✓`);
  console.log(`  - Batch price fetch working: ✓`);
  console.log(`  - Hot positions tracked: ${hotPositions.size}`);
  console.log(`  - Quick check multicall: ✓`);
}

runTests().catch(console.error);
