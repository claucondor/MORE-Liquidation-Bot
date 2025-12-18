const { utils } = require("ethers");

const EISEN_API_URL = 'https://hiker.hetz-01.eisenfinance.com/public/v1/quote';
const FLOW_CHAIN_ID = '747';

// Eisen Forwarder - the ONLY address that needs to be whitelisted
const EISEN_FORWARDER = '0x85EFA14c12F5fE42Ff9D7Da460A71088b26bEa31';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry helper for API calls with exponential backoff
async function retryApiCall(fn, maxRetries = 3, baseDelayMs = 1000) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            // Retry on 5xx errors, network errors, and timeout
            const isRetryable = err.message?.includes('HTTP error 5') ||
                                err.message?.includes('API key validation') ||
                                err.message?.includes('internal error') ||
                                err.message?.includes('timeout') ||
                                err.message?.includes('ETIMEDOUT') ||
                                err.message?.includes('ECONNRESET') ||
                                err.message?.includes('fetch failed');

            if (!isRetryable || attempt === maxRetries) {
                throw err;
            }

            const delay = baseDelayMs * Math.pow(2, attempt - 1);
            console.log(`[Eisen] API call failed (attempt ${attempt}/${maxRetries}): ${err.message?.slice(0, 80)}`);
            console.log(`[Eisen] Retrying in ${delay}ms...`);
            await sleep(delay);
        }
    }
    throw lastError;
}

/**
 * Get swap quote from Eisen Finance API
 *
 * CRITICAL: The toAddress parameter determines where the swap output goes!
 * - For repay swaps: toAddress = contractAddress (tokens stay in contract)
 * - For reward swaps: toAddress = receiverAddress (profit goes to receiver)
 */
async function getEisenQuote({
    fromToken,
    toToken,
    fromAmount,
    fromAddress,
    toAddress,  // CRITICAL: This determines where output goes!
    slippage = 0.02,
    apiKey
}) {
    const params = new URLSearchParams({
        fromChain: FLOW_CHAIN_ID,
        toChain: FLOW_CHAIN_ID,
        fromToken: fromToken.toLowerCase(),
        toToken: toToken.toLowerCase(),
        fromAmount: fromAmount.toString(),
        fromAddress,
        toAddress,  // Output destination
        slippage: slippage.toString(),
        integrator: 'more-liquidation',
        fee: '0',
        order: 'CHEAPEST'
    });

    const url = `${EISEN_API_URL}?${params}`;

    console.log(`[Eisen] Fetching quote: ${fromToken} -> ${toToken}`);
    console.log(`[Eisen] Amount: ${fromAmount}, toAddress: ${toAddress}`);

    const response = await fetch(url, {
        headers: {
            'X-EISEN-KEY': apiKey
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Eisen API HTTP error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Check for API errors
    if (data.code || data.message?.includes('error')) {
        throw new Error(`Eisen API error: ${data.message || JSON.stringify(data)}`);
    }

    if (!data.result || !data.result.transactionRequest) {
        throw new Error(`Eisen API invalid response: ${JSON.stringify(data)}`);
    }

    const result = data.result;

    return {
        router: result.transactionRequest.to,
        calldata: result.transactionRequest.data,
        expectedOutput: result.estimate.toAmount,
        minOutput: result.estimate.toAmountMin,
        priceImpact: result.estimate.priceImpact || '0',
        gasEstimate: result.estimate.gasCosts?.[0]?.estimate || '0',
        fromAmountUSD: result.estimate.fromAmountUSD,
        toAmountUSD: result.estimate.toAmountUSD
    };
}

/**
 * Build SwapParams for the contract
 *
 * @param {Object} params
 * @param {string} params.fromToken - Input token address
 * @param {string} params.toToken - Output token address
 * @param {string} params.fromAmount - Amount to swap (in wei)
 * @param {string} params.fromAddress - Contract address (where tokens come from)
 * @param {string} params.toAddress - Destination address (where tokens go)
 * @param {string} params.apiKey - Eisen API key
 * @param {number} params.slippage - Slippage tolerance (default 0.02 = 2%)
 */
async function buildSwapParams({
    fromToken,
    toToken,
    fromAmount,
    fromAddress,
    toAddress,
    apiKey,
    slippage = 0.02
}) {
    const quote = await retryApiCall(
        () => getEisenQuote({
            fromToken,
            toToken,
            fromAmount,
            fromAddress,
            toAddress,
            slippage,
            apiKey
        }),
        3, 1500
    );

    // Encode path for ApiAggregator: abi.encode(tokenIn, tokenOut, calldata)
    const abiCoder = new utils.AbiCoder();
    const path = abiCoder.encode(
        ['address', 'address', 'bytes'],
        [fromToken, toToken, quote.calldata]
    );

    // SwapType.ApiAggregator = 3
    const SWAP_TYPE_API_AGGREGATOR = 3;

    return {
        swapParams: {
            swapType: SWAP_TYPE_API_AGGREGATOR,
            router: quote.router,
            path: path,
            amountIn: fromAmount,
            amountOutMin: quote.minOutput,
            adapters: []
        },
        quote: quote
    };
}

/**
 * Build empty SwapParams (for when second swap is not needed)
 */
function buildEmptySwapParams() {
    return {
        swapType: 3,
        router: '0x0000000000000000000000000000000000000000',
        path: '0x',
        amountIn: 0,
        amountOutMin: 0,
        adapters: []
    };
}

module.exports = {
    getEisenQuote,
    buildSwapParams,
    buildEmptySwapParams,
    EISEN_API_URL,
    FLOW_CHAIN_ID,
    EISEN_FORWARDER
};
