/**
 * Telegram notification service
 */
const { Telegraf } = require('telegraf');
const { FLOWSCAN_URL, STRATEGY_INFO } = require('../constants');
const { shortAddr, formatUsd } = require('../utils/helpers');

class TelegramService {
  constructor(config) {
    this.bot = config.bot_token ? new Telegraf(config.bot_token) : null;
    this.alertChatId = config.alert_chat_id;
    this.infoChatId = config.info_chat_id;
    this.lastErrorMsg = null;
  }

  /**
   * Send alert message (important notifications)
   */
  async sendAlert(message) {
    if (!this.bot || !this.alertChatId) return;

    try {
      await this.bot.telegram.sendMessage(this.alertChatId, message, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    } catch (err) {
      console.error(`[Telegram] Alert error: ${err.message}`);
    }
  }

  /**
   * Send info message (status updates)
   * @param {string} message - The message to send
   * @param {Object} options - Optional settings
   * @param {boolean} options.html - Use HTML parsing (default: false for plain text)
   */
  async sendInfo(message, options = {}) {
    if (!this.bot || !this.infoChatId) return;

    try {
      const msgOptions = { disable_web_page_preview: true };
      if (options.html) {
        msgOptions.parse_mode = 'HTML';
      }
      await this.bot.telegram.sendMessage(this.infoChatId, message, msgOptions);
    } catch (err) {
      console.error(`[Telegram] Info error: ${err.message}`);
    }
  }

  /**
   * Send liquidation success notification
   */
  async notifyLiquidationSuccess({
    user,
    healthFactor,
    debtCovered,
    debtValueUsd,
    collateralSymbol,
    strategy,
    txHash,
    rewardDisplay,
    gasCostFlow,
    gasCostUsd,
    liquidatorBalance,
    liquidatorWflowBalance
  }) {
    const strategyInfo = STRATEGY_INFO[strategy] || { emoji: '📊', name: strategy };

    const message = [
      `✅ <b>Liquidation Success!</b> ${strategyInfo.emoji} ${strategyInfo.name}`,
      ``,
      `👤 ${shortAddr(user)}`,
      `📊 HF: ${healthFactor} → ~1.10`,
      ``,
      `💰 <b>Details:</b>`,
      `   Debt covered: ${formatUsd(debtValueUsd)} (50%)`,
      `   Collateral: ${collateralSymbol}`,
      ``,
      `📈 <b>Profit:</b>`,
      `   Reward: ${rewardDisplay}`,
      `   Gas: -${gasCostFlow.toFixed(4)} FLOW (~${formatUsd(gasCostUsd)})`,
      ``,
      `🏦 <b>Balance:</b> ${liquidatorBalance.toFixed(2)} FLOW | ${liquidatorWflowBalance.toFixed(4)} WFLOW`,
      ``,
      `🔗 <a href="${FLOWSCAN_URL}/tx/${txHash}">Tx</a> | <a href="${FLOWSCAN_URL}/address/${user}">Wallet</a>`
    ].join('\n');

    await this.sendAlert(message);
  }

  /**
   * Send liquidation failure notification
   */
  async notifyLiquidationFailure({ user, strategy, error, hint }) {
    // Avoid spam for same error
    const errorKey = `${user}:${error}`;
    if (this.lastErrorMsg === errorKey) return;
    this.lastErrorMsg = errorKey;

    const message = [
      `❌ <b>Liquidation Failed</b>`,
      ``,
      `👤 ${shortAddr(user)}`,
      `📊 Strategy: ${strategy}`,
      ``,
      `⚠️ Error: ${error?.slice(0, 100)}`,
      hint ? `💡 ${hint}` : ''
    ].filter(Boolean).join('\n');

    await this.sendAlert(message);
  }

  /**
   * Send target found notification
   */
  async notifyTargetFound({ user, healthFactor, debtValueUsd }) {
    const message = [
      `🎯 <b>Liquidation Target Found!</b>`,
      ``,
      `👤 ${shortAddr(user)}`,
      `📊 HF: ${healthFactor}`,
      `💰 Debt: ${formatUsd(debtValueUsd)}`
    ].join('\n');

    await this.sendAlert(message);
  }

  /**
   * Send bot started notification
   */
  async notifyBotStarted({ mode, loopInterval, wsConnected }) {
    const message = [
      `🤖 <b>Liquidation Bot Started</b>`,
      ``,
      `📡 Mode: ${wsConnected ? 'WebSocket' : 'Polling'}`,
      `⏱️ Full scan: every ${loopInterval}s`,
      `🔍 Quick check: every block`
    ].join('\n');

    await this.sendInfo(message);
  }

  /**
   * Send periodic status report
   */
  async notifyStatusReport({ hotPositions, lowestHf, liquidationsToday, uptime }) {
    const message = [
      `📊 <b>Status Report</b>`,
      ``,
      `🔥 Hot positions: ${hotPositions}`,
      `📉 Lowest HF: ${lowestHf}`,
      `✅ Liquidations today: ${liquidationsToday}`,
      `⏱️ Uptime: ${uptime}`
    ].join('\n');

    await this.sendInfo(message);
  }

  /**
   * Send RPC fallback notification
   */
  async notifyRpcFallback({ from, to }) {
    const message = `🔄 RPC switched: ${from} → ${to}`;
    await this.sendInfo(message);
  }
}

module.exports = TelegramService;
