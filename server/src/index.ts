/**
 * Process entry point: load config, wire real dependencies, start listening,
 * and shut down cleanly on SIGINT/SIGTERM (Render sends SIGTERM on deploy).
 */
import { createSplitAgent } from './ai_agent.js';
import { loadConfig } from './config.js';
import { Store } from './db.js';
import { EventHub } from './events.js';
import { PayPalClient } from './paypal.js';
import { createApp } from './server.js';

const config = loadConfig();
const store = new Store(config.DATABASE_PATH);
const hub = new EventHub();
const paypal = new PayPalClient({
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
  baseUrl: config.PAYPAL_API_BASE_URL,
  webhookId: config.PAYPAL_WEBHOOK_ID,
  brandName: config.PAYPAL_BRAND_NAME,
});
const agent = createSplitAgent(config.AI_PROVIDER, config.AI_API_KEY, {
  model: config.AI_MODEL,
  maxRetries: config.AI_MAX_RETRIES,
  defaultCurrency: config.DEFAULT_CURRENCY,
});

if (!config.PAYPAL_WEBHOOK_ID && !config.PAYPAL_WEBHOOK_SKIP_VERIFY) {
  console.warn('[boot] PAYPAL_WEBHOOK_ID is not set: webhooks will be rejected until it is configured.');
}

const app = createApp({ config, store, paypal, agent, hub });
const server = app.listen(config.PORT, () => {
  console.info(`[boot] SplitSense API on :${config.PORT} (PayPal ${paypal.isSandbox ? 'sandbox' : 'LIVE'}, ${config.AI_PROVIDER} ${config.AI_MODEL})`);
});

function shutdown(signal: string) {
  console.info(`[boot] ${signal} received, shutting down`);
  hub.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
