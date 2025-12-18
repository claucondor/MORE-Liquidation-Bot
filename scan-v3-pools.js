const { Contract, providers, utils } = require("ethers");
const config = require("./config.json");

const provider = new providers.JsonRpcProvider(config.rpc_url);

const V3_FACTORY = "0xca6d7Bb03334bBf135902e1d919a5feccb461632";
const QUOTER = "0x370A8DF17742867a44e56223EC20D82092242C85";
const SWAP_ROUTER = "0xeEDC6Ff75e1b10B903D9013c358e446a73d35341";

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"
];

const POOL_ABI = [
  "function liquidity() external view returns (uint128)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)"
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

// Use lowercase to avoid checksum issues
const TOKENS = {
  WFLOW: "0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e",
  USDF: "0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED",
  ankrFLOW: "0x1b97100eA1D7126C4d60027e231EA4CB25314bdb",
  stFLOW: "0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e", // placeholder - will scan later
};

const FEES = [100, 500, 3000, 10000];

async function findPools() {
  const factory = new Contract(V3_FACTORY, FACTORY_ABI, provider);

  console.log("=== FLOW V3 (DAO) POOLS ===");
  console.log("Factory:", V3_FACTORY);
  console.log("Quoter:", QUOTER);
  console.log("SwapRouter:", SWAP_ROUTER);
  console.log("");

  const pairs = [
    ["WFLOW", "USDF"],
    ["ankrFLOW", "WFLOW"],
    ["ankrFLOW", "USDF"],
    ["stFLOW", "WFLOW"],
    ["stFLOW", "USDF"],
  ];

  const foundPools = [];

  for (const [name0, name1] of pairs) {
    const token0 = TOKENS[name0];
    const token1 = TOKENS[name1];

    if (!token0 || !token1) continue;

    console.log(`--- ${name0}/${name1} ---`);

    for (const fee of FEES) {
      try {
        const poolAddress = await factory.getPool(token0, token1, fee);

        if (poolAddress === "0x0000000000000000000000000000000000000000") {
          continue;
        }

        const pool = new Contract(poolAddress, POOL_ABI, provider);
        const liq = await pool.liquidity();

        // Get balances
        const tok0Contract = new Contract(token0, ERC20_ABI, provider);
        const tok1Contract = new Contract(token1, ERC20_ABI, provider);

        const [bal0, bal1, dec0, dec1] = await Promise.all([
          tok0Contract.balanceOf(poolAddress),
          tok1Contract.balanceOf(poolAddress),
          tok0Contract.decimals(),
          tok1Contract.decimals()
        ]);

        const balance0 = Number(bal0.toString()) / Math.pow(10, dec0);
        const balance1 = Number(bal1.toString()) / Math.pow(10, dec1);

        // Calculate TVL
        let tvlUsd;
        if (name0 === "USDF") {
          tvlUsd = balance0 * 2;
        } else if (name1 === "USDF") {
          tvlUsd = balance1 * 2;
        } else {
          // Assume WFLOW ~$0.18
          const wflowBal = name0 === "WFLOW" ? balance0 : balance1;
          tvlUsd = wflowBal * 0.18 * 2;
        }

        console.log(`  ${fee/10000}% Fee: ${poolAddress}`);
        console.log(`    ${name0}: ${balance0.toLocaleString()}`);
        console.log(`    ${name1}: ${balance1.toLocaleString()}`);
        console.log(`    TVL: ~$${tvlUsd.toLocaleString()}`);

        foundPools.push({
          pair: `${name0}/${name1}`,
          fee,
          address: poolAddress,
          tvlUsd
        });

      } catch (err) {
        // Skip errors
      }
    }
    console.log("");
  }

  console.log("=== SUMMARY ===");
  console.log(`Found ${foundPools.length} V3 pools`);

  // Sort by TVL
  foundPools.sort((a, b) => b.tvlUsd - a.tvlUsd);

  console.log("\nTop pools by TVL:");
  for (const p of foundPools.slice(0, 5)) {
    console.log(`  ${p.pair} (${p.fee/10000}%): $${p.tvlUsd.toLocaleString()} - ${p.address}`);
  }
}

findPools().catch(console.error);
