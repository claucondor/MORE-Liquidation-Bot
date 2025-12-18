# Reporte de Liquidez - Protocolo MORE (Flow EVM)

**Fecha:** 2025-12-18
**Chain ID:** 747 (Flow EVM)

---

## Tokens del Protocolo MORE

| Token | Dirección | Decimales |
|-------|-----------|-----------|
| WFLOW | `0xd3bF53DAC106A0290B0483EcBC89d40FcC961f3e` | 18 |
| USDF | `0x2aaBea2058b5aC2D339b163C6Ab6f2b6d53aabED` | 6 |
| ankrFLOW | `0x1b97100eA1D7126C4d60027e231EA4CB25314bdb` | 18 |
| wBTC | `0x717DAE2BaF7656BE9a9B01deE31d571a9d4c9579` | 8 |
| stFLOW (Increment) | `0x5598c0652B899EB40f169Dd5949BdBE0BF36ffDe` | 18 |

---

## DEXes en Flow EVM

### 1. PunchSwap V2 (Uniswap V2 Fork)

**Contratos:**
- Router: `0xf45AFe28fd5519d5f8C1d4787a4D5f724C0eFa4d`
- Factory: `0x29372c22459a4e373851798bFd6808e71EA34A71`

**Fee:** 0.3%

### 2. FlowSwap V3 (Uniswap V3 Fork)

**Contratos:**
- Factory: `0xca6d7Bb03334bBf135902e1d919a5feccb461632`
- SwapRouter: `0xeEDC6Ff75e1b10B903D9013c358e446a73d35341`
- Quoter: `0x370A8DF17742867a44e56223EC20D82092242C85`

**Fees:** 0.01% (100), 0.05% (500), 0.3% (3000), 1% (10000)

### 3. MerlinSwap (iZUMi/iZiSwap Fork)

**Tipo:** Discretized-Liquidity-AMM (DLAMM) - Similar a Uniswap V3 pero con mejoras de eficiencia

**Contratos conocidos:**
- Pool stFLOW/WFLOW: `0xa7a55a52189DcBc14c4329753c86fF37D296b59C`

**Documentacion:** [iZUMi Finance](https://izumi.finance/) | [Developer Docs](https://developer.izumi.finance/)

---

## V2 Pairs (PunchSwap)

| Par | Dirección | Token0 | Token1 | Reserva0 | Reserva1 | USD Liquidez |
|-----|-----------|--------|--------|----------|----------|--------------|
| WFLOW/USDF | `0x17e96496212d06Eb1Ff10C6f853669Cc9947A1e7` | USDF (6 dec) | WFLOW (18 dec) | 1,689,919 USDF | 9,440,302 WFLOW | ~$3.4M |
| ankrFLOW/WFLOW | `0x442aE0F33d66F617AF9106e797fc251B574aEdb3` | ankrFLOW (18 dec) | WFLOW (18 dec) | 235,470 ankrFLOW | 260,954 WFLOW | ~$93K |
| wBTC/WFLOW | `0xAebc9efe5599D430Bc9045148992d3df50487ef2` | wBTC (8 dec) | WFLOW (18 dec) | 0.092 wBTC | 45,412 WFLOW | ~$16K |
| wBTC/USDF | `0x20E0CaE3EdBd9E5aEC1175c8293626443D3Dca31` | USDF (6 dec) | wBTC (8 dec) | 92,611 USDF | 1.04 wBTC | ~$185K |

**Pairs que NO EXISTEN en V2:**
- stFLOW/WFLOW
- stFLOW/USDF

---

## V3 Pools (FlowSwap)

| Par | Dirección | Fee | Liquidez | Estado |
|-----|-----------|-----|----------|--------|
| USDF/WFLOW | `0xd21C58aDaf1d1119FE40413b45A5f43d23d58DF3` | 0.3% (3000) | 2.54e18 | Activo |
| ankrFLOW/WFLOW | `0xbB577ac54E4641a7e2b38Ce39e794096CD11A639` | 0.01% (100) | 5.33e26 | **MUY ALTA** |
| wBTC/USDF | `0xf1B302b8683b40e1ad089ed6A0aE4F32A75A608f` | 0.3% (3000) | 3.19e8 | Activo |
| wBTC/USDF | `0xC5A7f1e427BD0FF7b64B9d2C43B93D670F5d932d` | 0.05% (500) | 0 | Vacío |

---

## MerlinSwap Pools (iZUMi DLAMM)

| Par | Dirección | Fee | stFLOW Balance | WFLOW Balance | USD Liquidez |
|-----|-----------|-----|----------------|---------------|--------------|
| stFLOW/WFLOW | `0xa7a55a52189DcBc14c4329753c86fF37D296b59C` | 0.05% (500) | 46.66 stFLOW | 1,097.97 WFLOW | **~$204** |

**NOTA:** Liquidez MUY BAJA - Solo sirve para liquidaciones de stFLOW < $100

---

## Rutas de Swap Disponibles

### Rutas Directas

| Colateral | Deuda | Ruta | DEX | Fee Total |
|-----------|-------|------|-----|-----------|
| WFLOW | USDF | WFLOW → USDF | V2 PunchSwap | 0.3% |
| USDF | WFLOW | USDF → WFLOW | V2 PunchSwap | 0.3% |
| ankrFLOW | WFLOW | ankrFLOW → WFLOW | V2 PunchSwap | 0.3% |
| wBTC | USDF | wBTC → USDF | V2 PunchSwap | 0.3% |
| wBTC | WFLOW | wBTC → WFLOW | V2 PunchSwap | 0.3% |

### Rutas Multi-Hop

| Colateral | Deuda | Ruta | DEX | Fee Total |
|-----------|-------|------|-----|-----------|
| ankrFLOW | USDF | ankrFLOW → WFLOW → USDF | V2 PunchSwap | 0.6% |
| wBTC | WFLOW (grande) | wBTC → USDF → WFLOW | V2 PunchSwap | 0.6% |

### Rutas con MerlinSwap (iZUMi)

| Colateral | Deuda | Ruta | DEX | Fee Total | Liquidez |
|-----------|-------|------|-----|-----------|----------|
| stFLOW | WFLOW | stFLOW → WFLOW | MerlinSwap | 0.05% | **MUY BAJA (~$204)** |
| stFLOW | USDF | stFLOW → WFLOW → USDF | MerlinSwap + PunchSwap | 0.35% | **MUY BAJA** |

### Sin Ruta Directa

| Token | Situación | Alternativa |
|-------|-----------|-------------|
| stFLOW (grande) | MerlinSwap tiene solo ~$204 liquidez | Eisen aggregator |

---

## Flash Loan/Swap Sources

### Para obtener USDF:
1. **V3 Flash** (0.3%): Pool `0xd21C...DF3` - Borrow USDF directamente
2. **V2 FlashSwap** (0.3%): Pair `0x17e9...A1e7` - Flash swap WFLOW→USDF
3. **Aave Flash** (0.05%): Pool MORE - Más barato pero más gas

### Para obtener WFLOW:
1. **V3 Flash** (0.3%): Pool `0xd21C...DF3` - Borrow WFLOW
2. **V3 Flash** (0.01%): Pool `0xbB57...639` - Borrow WFLOW (más barato)
3. **V2 FlashSwap** (0.3%): Múltiples pairs
4. **Aave Flash** (0.05%): Pool MORE

### Para obtener ankrFLOW:
1. **V3 Flash** (0.01%): Pool `0xbB57...639` - **MUY BARATO**
2. **V2 FlashSwap** (0.3%): Pair `0x442a...db3`

### Para obtener wBTC:
1. **V3 Flash** (0.3%): Pool `0xf1B3...08f` - Liquidez baja
2. **V2 FlashSwap** (0.3%): Pairs disponibles
3. **Aave Flash** (0.05%): Si hay liquidez en MORE

---

## Simulación de Swaps (V2)

| Swap | Input | Output | Slippage |
|------|-------|--------|----------|
| 100 WFLOW → USDF | 100 WFLOW | 17.86 USDF | ~0.1% |
| 1,000 WFLOW → USDF | 1,000 WFLOW | 178.64 USDF | ~0.1% |
| 10,000 WFLOW → USDF | 10,000 WFLOW | 1,784.80 USDF | ~0.1% |
| 100 WFLOW → ankrFLOW | 100 WFLOW | 89.92 ankrFLOW | ~0.4% |
| 1,000 WFLOW → ankrFLOW | 1,000 WFLOW | 896.21 ankrFLOW | ~0.4% |
| 100 ankrFLOW → USDF | 100 ankrFLOW | 19.73 USDF (via WFLOW) | ~0.5% |

---

## Capacidad de Liquidación por Token

| Token | Max Liquidación (bajo slippage) | Notas |
|-------|--------------------------------|-------|
| WFLOW | ~500,000 WFLOW (~$90K) | Alta liquidez |
| USDF | ~100,000 USDF | Alta liquidez |
| ankrFLOW | ~20,000 ankrFLOW (~$4K) | Liquidez media |
| wBTC | ~0.5 BTC (~$50K) | Liquidez baja, cuidado |
| stFLOW | ~$100 max | MerlinSwap tiene solo $204 liquidez |

---

## Contratos Whitelisted en FlashLoanLiquidation

**Proxy:** `0xc971348a2a9572f17D5626Ed3E3e37B438fEDc50`

### Router
- PunchSwap Router: `0xf45AFe28fd5519d5f8C1d4787a4D5f724C0eFa4d` ✅

### V2 Pairs (FlashSwap)
- WFLOW/USDF: `0x17e96496212d06Eb1Ff10C6f853669Cc9947A1e7` ✅
- ankrFLOW/WFLOW: `0x442aE0F33d66F617AF9106e797fc251B574aEdb3` ✅

### V3 Pools (Flash)
- USDF/WFLOW (0.3%): `0xd21C58aDaf1d1119FE40413b45A5f43d23d58DF3` ✅
- ankrFLOW/WFLOW (0.01%): `0xbB577ac54E4641a7e2b38Ce39e794096CD11A639` ✅

---

## Pendiente por Hacer

1. **Agregar soporte MerlinSwap al contrato** - Para liquidaciones pequeñas de stFLOW
2. **Whitelist wBTC pairs** - Para liquidaciones de wBTC
3. **Monitorear liquidez** - Crear monitor que alerte cambios significativos
4. **Investigar Curve pools** si existen en Flow

---

## Comparación de Fees para Flash

| Source | Fee | Gas Estimado | Mejor Para |
|--------|-----|--------------|------------|
| Aave Flash Loan | 0.05% | ~200K | Liquidaciones grandes |
| V3 Flash (0.01% pool) | 0.01% | ~150K | ankrFLOW |
| V3 Flash (0.3% pool) | 0.3% | ~150K | USDF/WFLOW pequeños |
| V2 FlashSwap | 0.3% | ~120K | Cuando ya necesitas swap |

---

## Notas Importantes

1. **ankrFLOW V3 pool tiene 0.01% fee** - Usar para flash cuando sea posible
2. **stFLOW no tiene liquidez en V2/V3** - Necesita Eisen o MerlinSwap
3. **wBTC tiene poca liquidez** - Max ~0.5 BTC por liquidación
4. **USDF tiene 6 decimales** - Cuidado con cálculos
5. **Config del bot tiene direcciones incorrectas** - ankrFLOW y stFLOW deben actualizarse
