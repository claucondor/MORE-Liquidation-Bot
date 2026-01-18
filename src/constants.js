/**
 * Constants and token addresses for the liquidation bot
 */
const { utils } = require('ethers');

// Chain info
const CHAIN_ID = 747;
const FLOWSCAN_URL = 'https://evm.flowscan.io';

// RPC endpoints
const PUBLIC_RPC = 'https://mainnet.evm.nodes.onflow.org';

// Token addresses (Flow EVM mainnet)
const TOKENS = {
  WFLOW: '0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e',
  ankrFLOW: '0x1b97100eA1D7126C4d60027e231EA4CB25314bdb',
  stgUSDC: '0xF1815bd50389c46847f0Bda824eC8da914045D14',
  USDF: '0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED',
  PYUSD0: '0x99aF3EeA856556646C98c8B9b2548Fe815240750',
};

// Token decimals
const DECIMALS = {
  [TOKENS.WFLOW]: 18,
  [TOKENS.ankrFLOW]: 18,
  [TOKENS.stgUSDC]: 6,
  [TOKENS.USDF]: 6,
  [TOKENS.PYUSD0]: 6,
};

// Stablecoins set (lowercase for easy lookup)
const STABLECOINS = new Set([
  TOKENS.PYUSD0.toLowerCase(),
  TOKENS.stgUSDC.toLowerCase(),
  TOKENS.USDF.toLowerCase(),
]);

// StableKitty pools (Curve-style, low slippage for stables)
const STABLEKITTY_POOLS = {
  'PYUSD0_stgUSDC': {
    address: '0x0e9712Ad7dbC3c0AC25765f57E8805C3fd3cF717',
    token0: TOKENS.PYUSD0,
    token1: TOKENS.stgUSDC,
    token0Index: 0,
    token1Index: 1
  },
  'USDF_PYUSD0': {
    address: '0x6ddDFa511A940cA3fD5Ec7F6a4f23947cA30f030',
    token0: TOKENS.USDF,
    token1: TOKENS.PYUSD0,
    token0Index: 0,
    token1Index: 1
  },
  'USDF_stgUSDC': {
    address: '0x20ca5d1C8623ba6AC8f02E41cCAFFe7bb6C92B57',
    token0: TOKENS.USDF,
    token1: TOKENS.stgUSDC,
    token0Index: 0,
    token1Index: 1
  }
};

// Fee constants (in basis points)
const FEES = {
  FLASH_LOAN_PREMIUM_BPS: 5n,    // 0.05% Aave/MORE flash loan
  FLASH_SWAP_FEE_BPS: 30n,       // 0.3% UniswapV2 flash swap
  STABLEKITTY_SLIPPAGE_BPS: 50n, // 0.5% max slippage for StableKitty
};

// Liquidation constants
const LIQUIDATION = {
  CONSERVATIVE_FACTOR: 99n,      // 99% of theoretical collateral
  CLOSE_FACTOR: 50n,             // Can liquidate up to 50% of debt
  LIQUIDATION_BONUS_BPS: 500n,   // 5% bonus
};

// Contract ABIs
const ABIS = {
  STABLEKITTY: [
    'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
    'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver) returns (uint256)',
    'function balances(uint256 i) view returns (uint256)'
  ],
  ERC20: [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
  ],
  V2_PAIR: [
    'function getReserves() view returns (uint112, uint112, uint32)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
  ],
  V3_POOL: [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function liquidity() view returns (uint128)',
  ],
};

// SwapType enum (must match contract)
const SwapType = {
  V2: 0,
  V3: 1,
  AggroKitty: 2,
  ApiAggregator: 3,
};

// Strategy enum
const Strategy = {
  STABLEKITTY_MORE: 'STABLEKITTY_MORE',
  STABLEKITTY_V3: 'STABLEKITTY_V3',
  V2_FLASH_SWAP: 'V2_FLASH_SWAP',
  V3_FLASH: 'V3_FLASH',
  V2_DIRECT_MORE: 'V2_DIRECT_MORE',
  V3_DIRECT: 'V3_DIRECT',
  EISEN_FLASH_LOAN: 'EISEN_FLASH_LOAN',
};

// Strategy display names and emojis
const STRATEGY_INFO = {
  [Strategy.STABLEKITTY_MORE]: { emoji: '🐱', name: 'StableKitty+MORE' },
  [Strategy.STABLEKITTY_V3]: { emoji: '🐱', name: 'StableKitty+V3' },
  [Strategy.V2_FLASH_SWAP]: { emoji: '⚡', name: 'V2 FlashSwap' },
  [Strategy.V3_FLASH]: { emoji: '🔷', name: 'V3 Flash' },
  [Strategy.V2_DIRECT_MORE]: { emoji: '💨', name: 'V2 Direct+MORE' },
  [Strategy.V3_DIRECT]: { emoji: '💎', name: 'V3 Direct' },
  [Strategy.EISEN_FLASH_LOAN]: { emoji: '🌐', name: 'Eisen' },
};

module.exports = {
  CHAIN_ID,
  FLOWSCAN_URL,
  PUBLIC_RPC,
  TOKENS,
  DECIMALS,
  STABLECOINS,
  STABLEKITTY_POOLS,
  FEES,
  LIQUIDATION,
  ABIS,
  SwapType,
  Strategy,
  STRATEGY_INFO,
};
