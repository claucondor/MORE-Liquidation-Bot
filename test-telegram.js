const { Telegraf } = require('telegraf');

// Check for config.json
let config;
try {
  config = require('./config.json');
} catch (err) {
  console.error('Error: config.json not found');
  console.error('Copy example_config.json to config.json and fill in your credentials:');
  console.error('  cp example_config.json config.json');
  process.exit(1);
}

async function testTelegram() {
  if (!config.bot_token || config.bot_token === 'bot_token_of_telegram_bot') {
    console.error('Error: bot_token not configured in config.json');
    process.exit(1);
  }

  const bot = new Telegraf(config.bot_token);
  const timestamp = new Date().toISOString();

  console.log('Testing Telegram connectivity...\n');

  // Test alert chat
  if (config.alert_chat_id && config.alert_chat_id !== '-0000000000') {
    try {
      await bot.telegram.sendMessage(
        config.alert_chat_id,
        `🔔 Test alert message from MORE Liquidation Bot\n\nTimestamp: ${timestamp}`
      );
      console.log(`✓ Alert chat (${config.alert_chat_id}): Message sent successfully`);
    } catch (err) {
      console.error(`✗ Alert chat (${config.alert_chat_id}): Failed - ${err.message}`);
    }
  } else {
    console.log('⚠ Alert chat: Not configured (alert_chat_id is placeholder)');
  }

  // Test info chat
  if (config.info_chat_id && config.info_chat_id !== '-0000000000') {
    try {
      await bot.telegram.sendMessage(
        config.info_chat_id,
        `ℹ️ Test info message from MORE Liquidation Bot\n\nTimestamp: ${timestamp}`
      );
      console.log(`✓ Info chat (${config.info_chat_id}): Message sent successfully`);
    } catch (err) {
      console.error(`✗ Info chat (${config.info_chat_id}): Failed - ${err.message}`);
    }
  } else {
    console.log('⚠ Info chat: Not configured (info_chat_id is placeholder)');
  }

  console.log('\nDone!');
}

testTelegram();
