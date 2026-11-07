/**
 * Centralised, validated runtime configuration.
 *
 * Every environment variable the server reads is declared here once, validated
 * with zod at boot, and exposed as a typed, frozen object. A misconfigured
 * deployment fails fast with a readable message instead of failing later inside
 * a payment flow.
 */
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env from the repo root or the server folder, whichever exists. Real env vars always win.
dotenv.config({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../.env')], quiet: true });

const booleanFromEnv = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Public URL of this app, used to build shareable payment links. */
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),

  PAYPAL_CLIENT_ID: z.string().min(1, 'PAYPAL_CLIENT_ID is required'),
  PAYPAL_CLIENT_SECRET: z.string().min(1, 'PAYPAL_CLIENT_SECRET is required'),
  PAYPAL_API_BASE_URL: z.string().url().default('https://api-m.sandbox.paypal.com'),
  /** ID of the webhook registered in the PayPal developer dashboard. */
  PAYPAL_WEBHOOK_ID: z.string().default(''),
  /** Development-only escape hatch for PayPal's webhook simulator. Ignored in production. */
  PAYPAL_WEBHOOK_SKIP_VERIFY: booleanFromEnv,
  PAYPAL_BRAND_NAME: z.string().default('SplitSense'),

  AI_API_KEY: z.string().min(1, 'AI_API_KEY (Anthropic API key) is required'),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  DATABASE_PATH: z.string().default('./data/splitsense.db'),
  /** HMAC key used to hash bill admin tokens before they are stored. */
  APP_SECRET: z.string().min(16, 'APP_SECRET must be at least 16 characters'),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(20).default(8),
});

export type AppConfig = Readonly<z.infer<typeof EnvSchema>>;

/** Parse an environment object into a validated config. Exported for tests. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example.`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && config.PAYPAL_WEBHOOK_SKIP_VERIFY) {
    throw new Error('PAYPAL_WEBHOOK_SKIP_VERIFY must never be enabled in production.');
  }
  return Object.freeze(config);
}
