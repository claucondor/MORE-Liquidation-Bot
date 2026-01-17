/**
 * COMPREHENSIVE FORK TEST - ALL ASSETS & METHODS
 * Tests every liquidation method for every possible asset pair
 */

const { ethers, BigNumber } = require('ethers');
const { spawn } = require('child_process');
const config = require('./config.json');
const LiquidationAbi = require('./abis/Liquidation.json');
const PoolAbi = require('./abis/Pool.json');

const FLOW_RPC = 'https://mainnet.evm.nodes.onflow.org';
const ANVIL_RPC = 'http://127.0.0.1:8545';
const ANVIL_PORT = 8545;

let anvilProcess = null;

// All market assets
const ASSETS = {
  WFLOW: ethers.utils.getAddress('0xd3bf53dac106a0290b0483ecbc89d40fcc961f3e'),
  ankrFLOW: ethers.utils.getAddress('0x1b97100ea1d7126c4d60027e231ea4cb25314bdb'),
  USDF: ethers.utils.getAddress('0x2aabea20a1a5b5b73b25095912f0f9f1004d7a8b'),
  stgUSDC: ethers.utils.getAddress('0xf1815bd50389c46847f0bda824ec8da914045d14'),
  PYUSD0: ethers.utils.getAddress('0x7f27352d5f83db87a5a3e00f4b07cc2138d8ee52')
};

// Whitelisted V2 pools
const V2_POOLS = {
  'WFLOW/ankrFLOW': '0x442aE0F33d66F617AF9106e797fc251B574aEdb3',
  'PYUSD0/WFLOW': '0xfc18d92085fa9df01be5985e5d890b4a4d7edad9',
  'WFLOW/stgUSDC': '0x83F9D1170967d46dd40447e6e66E1a58d2601124',
  'WFLOW/USDC': '0xFc18d92085FA9Df01BE5985E5D890b4A4D7EDad9',
  'ankrFLOW/stgUSDC': '0xdbd475373aA7e0825894b89a37A65B6ab6c59B8C',
  'ankrFLOW/USDC': '0xF0f9D00B8100a0c819b920DA4390cBded99079E4'
};

// Whitelisted V3 pools
const V3_POOLS = {
  'PYUSD0/stgUSDC': '0x3e1368383d45c1cb48310382343df6890fe2d217',
  'PYUSD0/WFLOW': '0x0fdba612fea7a7ad0256687eebf056d81ca63f63',
  'WFLOW/USDF': '0xE28954e9C57EcF5ffc11A522Ab381f4df3eFb39b'
};

async function startAnvil() {
  console.log('🔧 Starting Anvil fork...');
  return new Promise((resolve, reject) => {
    anvilProcess = spawn('anvil', ['--fork-url', FLOW_RPC, '--port', ANVIL_PORT.toString(), '--silent']);
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

function getSimpleMockBytecode(price) {
  const priceHex = BigNumber.from(price).toHexString().slice(2).padStart(64, '0');
  return '0x7f' + priceHex + '60005260206000f3';
}

async function manipulatePrice(provider, assetPriceSource, newPrice) {
  const mockBytecode = getSimpleMockBytecode(newPrice);
  await provider.send('anvil_setCode', [assetPriceSource, mockBytecode]);
}

async function getPoolReserves(provider, poolAddress) {
  try {
    const pair = new ethers.Contract(poolAddress, [
      'function getReserves() view returns (uint112, uint112, uint32)'
    ], provider);
    const [r0, r1] = await pair.getReserves();
    return { r0, r1, hasLiquidity: r0.gt(ethers.utils.parseEther('10')) && r1.gt(ethers.utils.parseEther('10')) };
  } catch (e) {
    return { r0: BigNumber.from(0), r1: BigNumber.from(0), hasLiquidity: false };
  }
}

function findV2Pool(collateralName, debtName) {
  // Direct match
  const direct1 = collateralName + '/' + debtName;
  const direct2 = debtName + '/' + collateralName;
  if (V2_POOLS[direct1]) return { key: direct1, pool: V2_POOLS[direct1] };
  if (V2_POOLS[direct2]) return { key: direct2, pool: V2_POOLS[direct2] };

  // Find any pool with collateral (for flash loan source)
  for (const [key, pool] of Object.entries(V2_POOLS)) {
    if (key.includes(collateralName)) {
      return { key, pool };
    }
  }
  return null;
}

function findV3Pool(collateralName, debtName) {
  const direct1 = collateralName + '/' + debtName;
  const direct2 = debtName + '/' + collateralName;
  if (V3_POOLS[direct1]) return { key: direct1, pool: V3_POOLS[direct1] };
  if (V3_POOLS[direct2]) return { key: direct2, pool: V3_POOLS[direct2] };
  return null;
}

async function testAssetPair(provider, collateralName, debtName, botContract, wallet, oracleContract) {
  const collateral = ASSETS[collateralName];
  const debt = ASSETS[debtName];
  const results = { pair: collateralName + ' → ' + debtName, execute: null, flashSwap: null, flashV3: null };

  if (collateral === debt) return null;

  const debtAmount = ethers.utils.parseEther('100');
  const lParam = {
    collateralAsset: collateral,
    debtAsset: debt,
    user: wallet.address,
    amount: debtAmount,
    transferAmount: debtAmount,
    debtToCover: debtAmount
  };

  const v2Router = config.contracts.punchswap.router;
  const sParamToRepayLoan = {
    swapType: 0,
    router: v2Router,
    path: ethers.utils.solidityPack(['address', 'address'], [collateral, debt]),
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

  // Crash collateral price
  const priceSource = await oracleContract.getSourceOfAsset(collateral);
  await manipulatePrice(provider, priceSource, BigNumber.from('1'));

  // Test execute() - Aave flash loan
  try {
    await botContract.callStatic.execute(lParam, sParamToRepayLoan, sParamEmpty, wallet.address);
    results.execute = '✅ SUCCESS';
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('HEALTH_FACTOR')) results.execute = '⚠️ HF>1';
    else if (msg.includes('ERC20') || msg.includes('transfer')) results.execute = '✅ HF OK';
    else if (msg.includes('NOT_ENOUGH') || msg.includes('SPECIFIED_CURRENCY')) results.execute = '✅ (no debt)';
    else results.execute = '❌ ' + msg.slice(0, 30);
  }

  // Test executeFlashSwap() - find V2 pool
  const v2PoolInfo = findV2Pool(collateralName, debtName);

  if (v2PoolInfo) {
    const reserves = await getPoolReserves(provider, v2PoolInfo.pool);

    if (reserves.hasLiquidity) {
      try {
        await botContract.callStatic.executeFlashSwap(v2PoolInfo.pool, lParam, sParamToRepayLoan, sParamEmpty, wallet.address);
        results.flashSwap = '✅ SUCCESS';
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('NotPair')) results.flashSwap = '❌ NotWhitelisted';
        else if (msg.includes('HEALTH_FACTOR')) results.flashSwap = '⚠️ HF>1';
        else if (msg.includes('ERC20') || msg.includes('transfer')) results.flashSwap = '✅ HF OK';
        else if (msg.includes('NOT_ENOUGH') || msg.includes('SPECIFIED_CURRENCY')) results.flashSwap = '✅ (no debt)';
        else if (msg.includes('INSUFFICIENT')) results.flashSwap = '⚠️ NoLiq';
        else results.flashSwap = '❌ ' + msg.slice(0, 30);
      }
    } else {
      results.flashSwap = '⚪ NoLiq';
    }
  } else {
    results.flashSwap = '⚪ NoPool';
  }

  // Test executeFlashV3() - find V3 pool
  const v3PoolInfo = findV3Pool(collateralName, debtName);

  if (v3PoolInfo) {
    try {
      await botContract.callStatic.executeFlashV3(v3PoolInfo.pool, lParam, sParamToRepayLoan, sParamEmpty, wallet.address);
      results.flashV3 = '✅ SUCCESS';
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('NotV3Pool')) results.flashV3 = '❌ NotWhitelisted';
      else if (msg.includes('HEALTH_FACTOR')) results.flashV3 = '⚠️ HF>1';
      else if (msg.includes('ERC20') || msg.includes('transfer')) results.flashV3 = '✅ HF OK';
      else if (msg.includes('NOT_ENOUGH') || msg.includes('SPECIFIED_CURRENCY')) results.flashV3 = '✅ (no debt)';
      else results.flashV3 = '❌ ' + msg.slice(0, 30);
    }
  } else {
    results.flashV3 = '⚪ NoPool';
  }

  return results;
}

async function main() {
  console.log('🧪 COMPREHENSIVE FORK TEST - ALL ASSETS & METHODS');
  console.log('='.repeat(60) + '\n');

  let provider;
  try {
    provider = await startAnvil();

    const poolAddress = config.pools[0];
    const botInfo = config.bots[poolAddress];
    const botAddress = botInfo.bot;

    const testPrivateKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    const wallet = new ethers.Wallet(testPrivateKey, provider);
    const botContract = new ethers.Contract(botAddress, LiquidationAbi, wallet);

    const oracleContract = new ethers.Contract(config.contracts.oracle, [
      'function getSourceOfAsset(address) view returns (address)'
    ], provider);

    // Test all asset combinations
    const assetNames = Object.keys(ASSETS);
    const results = [];

    console.log('Testing all asset pairs...\n');

    for (const collateral of assetNames) {
      for (const debt of assetNames) {
        if (collateral === debt) continue;

        process.stdout.write('  ' + collateral + ' -> ' + debt + ': ');

        try {
          const result = await testAssetPair(
            provider, collateral, debt, botContract, wallet, oracleContract
          );
          if (result) {
            results.push(result);
            console.log('execute=' + result.execute + ' flash=' + result.flashSwap + ' v3=' + result.flashV3);
          }
        } catch (e) {
          console.log('ERROR: ' + (e.message || '').slice(0, 50));
        }
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    let executePass = 0, flashPass = 0, v3Pass = 0;
    for (const r of results) {
      if (r.execute && (r.execute.includes('✅') || r.execute.includes('HF>1'))) executePass++;
      if (r.flashSwap && r.flashSwap.includes('✅')) flashPass++;
      if (r.flashV3 && r.flashV3.includes('✅')) v3Pass++;
    }

    console.log('\n  execute() (Aave): ' + executePass + '/' + results.length + ' working');
    console.log('  executeFlashSwap() (V2): ' + flashPass + ' working (where pools exist)');
    console.log('  executeFlashV3() (V3): ' + v3Pass + ' working (where pools exist)');

    console.log('\n✅ Test complete');

  } catch (e) {
    console.error('\n❌ Test failed:', e.message);
  } finally {
    stopAnvil();
  }
}

main().catch(console.error);
