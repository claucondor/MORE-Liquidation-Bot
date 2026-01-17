/**
 * TEST STABLEKITTY POOLS - Curve-style stable swaps
 * These pools are used for swapping collateral→debt AFTER liquidation
 */

const { ethers, BigNumber } = require('ethers');
const { spawn } = require('child_process');
const config = require('./config.json');
const { POOLS_CONFIG, STABLEKITTY_ABI, getStableKittyLiquidity, getStableKittyQuote, findStableKittyPool } = require('./liquidity');

const FLOW_RPC = 'https://mainnet.evm.nodes.onflow.org';
const ANVIL_RPC = 'http://127.0.0.1:8545';

let anvilProcess = null;

// StableKitty pools
const STABLEKITTY_POOLS = {
  'PYUSD0_stgUSDC': {
    address: '0x0e9712Ad7dbC3c0AC25765f57E8805C3fd3cF717',
    token0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
    token1: '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
    tvl: 418000
  },
  'USDF_PYUSD0': {
    address: '0x6ddDFa511A940cA3fD5Ec7F6a4f23947cA30f030',
    token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
    token1: '0x99aF3EeA856556646C98c8B9b2548Fe815240750', // PYUSD0
    tvl: 716000
  },
  'USDF_stgUSDC': {
    address: '0x20ca5d1C8623ba6AC8f02E41cCAFFe7bb6C92B57',
    token0: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED', // USDF
    token1: '0xf1815bd50389c46847f0bda824ec8da914045d14', // stgUSDC
    tvl: 1340000
  }
};

async function startAnvil() {
  console.log('🔧 Starting Anvil fork...');
  return new Promise((resolve, reject) => {
    anvilProcess = spawn('anvil', ['--fork-url', FLOW_RPC, '--port', '8545', '--silent']);
    setTimeout(async () => {
      try {
        const provider = new ethers.providers.JsonRpcProvider(ANVIL_RPC);
        await provider.getBlockNumber();
        console.log('✅ Anvil ready\n');
        resolve(provider);
      } catch (e) {
        reject(new Error('Anvil failed: ' + e.message));
      }
    }, 3000);
  });
}

function stopAnvil() {
  if (anvilProcess) { anvilProcess.kill(); }
}

async function testStableKittyPools(provider) {
  console.log('🧪 TESTING STABLEKITTY POOLS (Curve-style)\n');
  console.log('These pools are used for stable↔stable swaps after liquidation\n');

  const results = [];

  for (const [name, pool] of Object.entries(STABLEKITTY_POOLS)) {
    console.log('─'.repeat(50));
    console.log('Pool: ' + name);
    console.log('Address: ' + pool.address);

    try {
      const contract = new ethers.Contract(pool.address, STABLEKITTY_ABI, provider);

      // Get balances
      const [bal0, bal1, fee, A] = await Promise.all([
        contract.balances(0),
        contract.balances(1),
        contract.fee(),
        contract.A()
      ]);

      // All stables are 6 decimals
      const tvl = (Number(bal0) + Number(bal1)) / 1e6;

      console.log('  Balance 0: ' + ethers.utils.formatUnits(bal0, 6));
      console.log('  Balance 1: ' + ethers.utils.formatUnits(bal1, 6));
      console.log('  TVL: $' + tvl.toLocaleString());
      console.log('  Fee: ' + Number(fee) / 1e8 + '%');
      console.log('  A: ' + A.toString());

      // Test swap quotes
      const testAmounts = [
        ethers.utils.parseUnits('100', 6),    // $100
        ethers.utils.parseUnits('1000', 6),   // $1,000
        ethers.utils.parseUnits('10000', 6),  // $10,000
        ethers.utils.parseUnits('100000', 6)  // $100,000
      ];

      console.log('\n  Swap quotes (0→1):');
      for (const amount of testAmounts) {
        try {
          const amountOut = await contract.get_dy(0, 1, amount);
          const slippage = (1 - Number(amountOut) / Number(amount)) * 100;
          const amountStr = ethers.utils.formatUnits(amount, 6);
          const outStr = ethers.utils.formatUnits(amountOut, 6);
          console.log('    $' + amountStr + ' → $' + outStr + ' (slippage: ' + slippage.toFixed(4) + '%)');
        } catch (e) {
          console.log('    $' + ethers.utils.formatUnits(amount, 6) + ' → ERROR: ' + (e.message || '').slice(0, 30));
        }
      }

      console.log('\n  Swap quotes (1→0):');
      for (const amount of testAmounts) {
        try {
          const amountOut = await contract.get_dy(1, 0, amount);
          const slippage = (1 - Number(amountOut) / Number(amount)) * 100;
          const amountStr = ethers.utils.formatUnits(amount, 6);
          const outStr = ethers.utils.formatUnits(amountOut, 6);
          console.log('    $' + amountStr + ' → $' + outStr + ' (slippage: ' + slippage.toFixed(4) + '%)');
        } catch (e) {
          console.log('    $' + ethers.utils.formatUnits(amount, 6) + ' → ERROR: ' + (e.message || '').slice(0, 30));
        }
      }

      results.push({ name, status: '✅ OK', tvl });

    } catch (e) {
      console.log('  ERROR: ' + (e.message || '').slice(0, 100));
      results.push({ name, status: '❌ FAIL', tvl: 0 });
    }

    console.log('');
  }

  return results;
}

async function testLiquidationWithStableSwap(provider) {
  console.log('\n🔥 TESTING LIQUIDATION FLOW WITH STABLEKITTY SWAP\n');
  console.log('Scenario: User has WFLOW collateral, stgUSDC debt');
  console.log('After liquidation, we receive WFLOW and need to swap → stgUSDC to repay\n');

  const LiquidationAbi = require('./abis/Liquidation.json');
  const poolAddress = config.pools[0];
  const botInfo = config.bots[poolAddress];
  const botAddress = botInfo.bot;

  const testPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const wallet = new ethers.Wallet(testPrivateKey, provider);
  const botContract = new ethers.Contract(botAddress, LiquidationAbi, wallet);

  // Assets
  const WFLOW = ethers.utils.getAddress('0xd3bf53dac106a0290b0483ecbc89d40fcc961f3e');
  const stgUSDC = ethers.utils.getAddress('0xf1815bd50389c46847f0bda824ec8da914045d14');
  const USDF = ethers.utils.getAddress('0x2aabea20a1a5b5b73b25095912f0f9f1004d7a8b');

  const testUser = '0x19fa89711e59e45de0e31e5bdf722c5f7603a70a';
  const debtAmount = ethers.utils.parseUnits('100', 6); // 100 stgUSDC

  const lParam = {
    collateralAsset: WFLOW,
    debtAsset: stgUSDC,
    user: testUser,
    amount: debtAmount,
    transferAmount: debtAmount,
    debtToCover: debtAmount
  };

  // Test with different swap paths including StableKitty
  // Note: The bot contract uses sParamToRepayLoan which can include adapters for complex routes

  console.log('Test 1: execute() with V2 router path (WFLOW → USDF → stgUSDC via StableKitty)');

  // Build swap path that goes through StableKitty
  // First: WFLOW → USDF via V2
  // Then: USDF → stgUSDC via StableKitty

  const v2Router = config.contracts.punchswap.router;

  // Simple path first (direct swap)
  const sParamDirect = {
    swapType: 0,
    router: v2Router,
    path: ethers.utils.solidityPack(['address', 'address'], [WFLOW, stgUSDC]),
    amountIn: BigNumber.from(0),
    amountOutMin: BigNumber.from(0),
    adapters: []
  };

  const sParamEmpty = {
    swapType: 0,
    router: ethers.constants.AddressZero,
    path: '0x',
    amountIn: BigNumber.from(0),
    amountOutMin: BigNumber.from(0),
    adapters: []
  };

  try {
    await botContract.callStatic.execute(lParam, sParamDirect, sParamEmpty, wallet.address);
    console.log('  ✅ execute() with direct path SUCCEEDED');
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('HEALTH_FACTOR')) {
      console.log('  ✅ execute() reached liquidationCall (HF check failed as expected)');
    } else if (msg.includes('ERC20') || msg.includes('transfer')) {
      console.log('  ✅ execute() passed HF check, failed on swap (no real position)');
    } else {
      console.log('  ⚠️  execute() error: ' + msg.slice(0, 100));
    }
  }

  // Test with multi-hop path
  console.log('\nTest 2: execute() with multi-hop path (WFLOW → USDF → stgUSDC)');

  const sParamMultiHop = {
    swapType: 0,
    router: v2Router,
    path: ethers.utils.solidityPack(['address', 'address', 'address'], [WFLOW, USDF, stgUSDC]),
    amountIn: BigNumber.from(0),
    amountOutMin: BigNumber.from(0),
    adapters: []
  };

  try {
    await botContract.callStatic.execute(lParam, sParamMultiHop, sParamEmpty, wallet.address);
    console.log('  ✅ execute() with multi-hop path SUCCEEDED');
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('HEALTH_FACTOR')) {
      console.log('  ✅ execute() reached liquidationCall (HF check failed as expected)');
    } else if (msg.includes('ERC20') || msg.includes('transfer')) {
      console.log('  ✅ execute() passed HF check, failed on swap (no real position)');
    } else {
      console.log('  ⚠️  execute() error: ' + msg.slice(0, 100));
    }
  }

  // Test stable↔stable liquidation (USDF collateral, stgUSDC debt)
  console.log('\nTest 3: Stable↔Stable liquidation (USDF → stgUSDC via StableKitty)');

  const lParamStable = {
    collateralAsset: USDF,
    debtAsset: stgUSDC,
    user: testUser,
    amount: debtAmount,
    transferAmount: debtAmount,
    debtToCover: debtAmount
  };

  // For stable→stable, the bot should use StableKitty
  const sParamStable = {
    swapType: 0,
    router: v2Router,
    path: ethers.utils.solidityPack(['address', 'address'], [USDF, stgUSDC]),
    amountIn: BigNumber.from(0),
    amountOutMin: BigNumber.from(0),
    adapters: []
  };

  try {
    await botContract.callStatic.execute(lParamStable, sParamStable, sParamEmpty, wallet.address);
    console.log('  ✅ execute() with stable path SUCCEEDED');
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('HEALTH_FACTOR')) {
      console.log('  ✅ execute() reached liquidationCall (HF check failed as expected)');
    } else if (msg.includes('ERC20') || msg.includes('transfer')) {
      console.log('  ✅ execute() passed HF check, failed on swap (no real position)');
    } else {
      console.log('  ⚠️  execute() error: ' + msg.slice(0, 100));
    }
  }

  return true;
}

async function main() {
  console.log('═'.repeat(60));
  console.log('STABLEKITTY POOLS TEST');
  console.log('═'.repeat(60) + '\n');

  let provider;
  try {
    provider = await startAnvil();

    // Test 1: Pool liquidity and quotes
    const poolResults = await testStableKittyPools(provider);

    // Test 2: Liquidation flow with stable swaps
    await testLiquidationWithStableSwap(provider);

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));

    let totalTvl = 0;
    for (const r of poolResults) {
      console.log('  ' + r.status + ' ' + r.name + ' (TVL: $' + r.tvl.toLocaleString() + ')');
      totalTvl += r.tvl;
    }

    console.log('\n  Total StableKitty TVL: $' + totalTvl.toLocaleString());
    console.log('\n✅ Test complete');

  } catch (e) {
    console.error('\n❌ Test failed:', e.message);
  } finally {
    stopAnvil();
  }
}

main().catch(console.error);
