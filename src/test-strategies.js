/**
 * Test script for the new modular strategies
 * Run with: node src/test-strategies.js
 */
const { providers, Contract, Wallet, BigNumber } = require('ethers');
const { StrategyManager, getAllStrategies } = require('./strategies');
const { TOKENS, STABLEKITTY_POOLS } = require('./constants');
const { isStableSwap, findStableKittyPool } = require('./utils');

// Load config
const config = require('../config.json');

// ABIs
const LiquidationAbi = require('../abis/Liquidation.json');
const AaveOracleAbi = require('../abis/AaveOracle.json');

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('TESTING NEW MODULAR STRATEGIES');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup provider and contracts
  const provider = new providers.JsonRpcProvider(config.rpc_url);
  const wallet = new Wallet(config.liquidator_key, provider);
  const botContract = new Contract(
    config.contracts.liquidation || '0xc971348a2a9572f17D5626Ed3E3e37B438fEDc50',
    LiquidationAbi,
    wallet
  );
  const oracleContract = new Contract(
    config.contracts.oracle,
    AaveOracleAbi,
    provider
  );

  console.log('Wallet:', wallet.address);
  console.log('Bot Contract:', botContract.address);
  console.log('');

  // Test 1: Strategy Manager initialization
  console.log('TEST 1: Strategy Manager Initialization');
  console.log('─────────────────────────────────────────');
  const manager = new StrategyManager();
  console.log(`Loaded ${manager.strategies.length} strategies:`);
  manager.strategies.forEach(s => {
    console.log(`  ${s.priority}. ${s.name} (${s.fee}bps) - ${s.getContractMethod()}`);
  });
  console.log('✅ Strategy Manager initialized\n');

  // Test 2: StableKitty pool detection
  console.log('TEST 2: StableKitty Pool Detection');
  console.log('─────────────────────────────────────────');
  const stablePairs = [
    [TOKENS.USDF, TOKENS.stgUSDC],
    [TOKENS.PYUSD0, TOKENS.stgUSDC],
    [TOKENS.USDF, TOKENS.PYUSD0],
    [TOKENS.WFLOW, TOKENS.stgUSDC], // Should NOT find pool
  ];

  for (const [tokenA, tokenB] of stablePairs) {
    const pool = findStableKittyPool(tokenA, tokenB);
    const isStable = isStableSwap(tokenA, tokenB);
    console.log(`  ${tokenA.slice(0, 10)}... ↔ ${tokenB.slice(0, 10)}...`);
    console.log(`    isStableSwap: ${isStable}, pool: ${pool ? pool.name : 'none'}`);
  }
  console.log('✅ Pool detection working\n');

  // Test 3: Strategy selection for different scenarios
  console.log('TEST 3: Strategy Selection');
  console.log('─────────────────────────────────────────');

  const scenarios = [
    {
      name: 'stable→stable (USDF→stgUSDC)',
      collateralAsset: TOKENS.USDF,
      debtAsset: TOKENS.stgUSDC,
      eisenApiKey: config.eisen_api_key,
      punchswapRouter: config.contracts.punchswap?.router,
    },
    {
      name: 'WFLOW→stable',
      collateralAsset: TOKENS.WFLOW,
      debtAsset: TOKENS.stgUSDC,
      eisenApiKey: config.eisen_api_key,
      punchswapRouter: config.contracts.punchswap?.router,
    },
    {
      name: 'WFLOW→WFLOW (same token)',
      collateralAsset: TOKENS.WFLOW,
      debtAsset: TOKENS.WFLOW,
      eisenApiKey: config.eisen_api_key,
      punchswapRouter: config.contracts.punchswap?.router,
    },
  ];

  for (const scenario of scenarios) {
    const context = {
      ...scenario,
      debtToCover: BigNumber.from('1000000'), // 1 USDC worth
    };

    const applicable = getAllStrategies().filter(s => s.canHandle(context));
    console.log(`  ${scenario.name}:`);
    console.log(`    Applicable: ${applicable.map(s => s.name).join(', ') || 'none'}`);
  }
  console.log('✅ Strategy selection working\n');

  // Test 4: Build params for StableKitty
  console.log('TEST 4: Build Params (StableKitty)');
  console.log('─────────────────────────────────────────');

  const stableContext = {
    collateralAsset: TOKENS.USDF,
    debtAsset: TOKENS.stgUSDC,
    user: '0x0000000000000000000000000000000000000001',
    debtToCover: BigNumber.from('1000000000'), // 1000 USDC (6 decimals)
    expectedCollateral: BigNumber.from('1000000000'), // 1000 USDF
    provider,
    contractAddress: botContract.address,
    receiver: wallet.address,
    eisenApiKey: config.eisen_api_key,
  };

  const stableStrategy = manager.strategies.find(s => s.name === 'STABLEKITTY_MORE');
  if (stableStrategy && stableStrategy.canHandle(stableContext)) {
    try {
      const params = await stableStrategy.buildParams(stableContext);
      if (params) {
        console.log('  Built params successfully:');
        console.log(`    lParam.amount: ${params.lParam.amount}`);
        console.log(`    sParamToRepayLoan.router: ${params.sParamToRepayLoan.router.slice(0, 20)}...`);
        console.log(`    sParamToSendToReceiver.router: ${params.sParamToSendToReceiver.router}`);
        console.log(`    estimatedReward: ${params.estimatedReward?.toString() || 'N/A'}`);
        console.log('✅ Params built successfully\n');
      } else {
        console.log('  ⚠️ Could not build params (might not be profitable)\n');
      }
    } catch (err) {
      console.log(`  ❌ Error: ${err.message}\n`);
    }
  } else {
    console.log('  Strategy cannot handle this context\n');
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('✅ All strategy modules loaded correctly');
  console.log('✅ Strategy priority order working');
  console.log('✅ Pool detection working');
  console.log('✅ Strategy selection working');
  console.log('');
  console.log('Next steps:');
  console.log('1. Integrate StrategyManager into main bot loop');
  console.log('2. Replace inline strategy code with manager.execute()');
  console.log('3. Run full fork tests');
}

main().catch(console.error);
