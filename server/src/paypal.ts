/**
 * PayPal REST API client (Sandbox or Live, selected by base URL).
 *
 * Covers everything SplitSense needs and nothing more:
 *   - OAuth 2.0 client-credentials token with in-memory caching, early refresh
 *     and single-flight deduplication (concurrent callers share one request).
 *   - Orders v2: create, capture, get.
 *   - Webhook signature verification via /v1/notifications/verify-webhook-signature.
 *
 * Uses the platform `fetch` (Node >= 18). A fetch implementation can be
 * injected for tests.
 */
import { randomUUID } from 'node:crypto';
import { centsToDecimal } from './money.js';

type FetchLike = typeof fetch;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
  webhookId: string;
  brandName: string;
  fetchImpl?: FetchLike;
  /** Refresh the token this many ms before PayPal says it expires. */
  refreshSkewMs?: number;
}

/** Error raised for any non-2xx PayPal response; carries PayPal's debug_id for support tickets. */
export class PayPalApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issue: string | null,
    public readonly debugId: string | null,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }
}

export interface OrderLineItem {
  name: string;
  amountCents: number;
  /** Optional detail shown to the buyer in the PayPal review page. */
  description?: string;
}

export interface CreateOrderInput {
  /** Our internal share ID; stored in custom_id so webhooks can be mapped back. */
  referenceId: string;
  currency: string;
  description: string;
  items: OrderLineItem[];
  taxCents: number;
  handlingCents: number;
  discountCents: number;
  returnUrl: string;
  cancelUrl: string;
  requestId?: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalCapture {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  amount: PayPalMoney;
  custom_id?: string;
  status_details?: { reason?: string };
}

export interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  links?: PayPalLink[];
  payer?: {
    name?: { given_name?: string; surname?: string };
    email_address?: string;
    payer_id?: string;
  };
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    amount?: PayPalMoney;
    payments?: { captures?: PayPalCapture[] };
  }>;
}

export interface WebhookHeaders {
  'paypal-auth-algo'?: string;
  'paypal-cert-url'?: string;
  'paypal-transmission-id'?: string;
  'paypal-transmission-sig'?: string;
  'paypal-transmission-time'?: string;
}

/** Trim to PayPal's field limits so long receipt item names never cause a 422. */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export class PayPalClient {
  private readonly fetchImpl: FetchLike;
  private readonly refreshSkewMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private inflightToken: Promise<string> | null = null;

  constructor(private readonly options: PayPalClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.refreshSkewMs = options.refreshSkewMs ?? 60_000;
  }

  get isSandbox(): boolean {
    return this.options.baseUrl.includes('sandbox');
  }

  /** Return a valid bearer token, fetching or refreshing it only when needed. */
  async getAccessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - this.refreshSkewMs) {
      return this.token.value;
    }
    if (!this.inflightToken) {
      this.inflightToken = this.fetchToken().finally(() => {
        this.inflightToken = null;
      });
    }
    return this.inflightToken;
  }

  /** Drop the cached token, e.g. after PayPal rejects it with 401. */
  invalidateToken(): void {
    this.token = null;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString('base64');
    const response = await this.fetchImpl(`${this.options.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!response.ok || !body.access_token) {
      throw new PayPalApiError(
        `PayPal OAuth failed: ${body.error_description ?? response.statusText}`,
        response.status,
        'AUTHENTICATION_FAILURE',
        response.headers.get('paypal-debug-id'),
        body,
      );
    }
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  /**
   * Authenticated JSON request. Retries exactly once with a fresh token if
   * PayPal answers 401 (token revoked or expired early).
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: string; requestId?: string } = {},
    retried = false,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'return=representation',
    };
    if (options.requestId) headers['PayPal-Request-Id'] = options.requestId;

    const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      body: options.body,
    });

    if (response.status === 401 && !retried) {
      this.invalidateToken();
      return this.request<T>(method, path, options, true);
    }

    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const err = json as { name?: string; message?: string; debug_id?: string; details?: Array<{ issue?: string; description?: string }> };
      const issue = err.details?.[0]?.issue ?? err.name ?? null;
      const description = err.details?.[0]?.description ?? err.message ?? response.statusText;
      throw new PayPalApiError(
        `PayPal ${method} ${path} failed (${response.status}): ${issue ?? ''} ${description}`.trim(),
        response.status,
        issue,
        err.debug_id ?? response.headers.get('paypal-debug-id'),
        json,
      );
    }
    return json as T;
  }

  /** Build the Orders v2 request body. Exported separately so it can be unit tested. */
  buildOrderBody(input: CreateOrderInput): Record<string, unknown> {
    const currency = input.currency;
    const money = (cents: number): PayPalMoney => ({ currency_code: currency, value: centsToDecimal(cents) });
    const items = input.items.filter((item) => item.amountCents > 0);
    const itemTotal = items.reduce((sum, item) => sum + item.amountCents, 0);
    const total = itemTotal + input.taxCents + input.handlingCents - input.discountCents;
    if (total <= 0) throw new Error('Order total must be greater than zero');

    const breakdown: Record<string, PayPalMoney> = { item_total: money(itemTotal) };
    if (input.taxCents > 0) breakdown.tax_total = money(input.taxCents);
    if (input.handlingCents > 0) breakdown.handling = money(input.handlingCents);
    if (input.discountCents > 0) breakdown.discount = money(input.discountCents);

    return {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.referenceId,
          custom_id: input.referenceId,
          description: clip(input.description, 127),
          soft_descriptor: clip(this.options.brandName.replace(/[^A-Za-z0-9 ]/g, ''), 22),
          amount: { ...money(total), breakdown },
          items: items.map((item) => ({
            name: clip(item.name, 127),
            ...(item.description ? { description: clip(item.description, 127) } : {}),
            quantity: '1',
            unit_amount: money(item.amountCents),
            category: 'DIGITAL_GOODS',
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: clip(this.options.brandName, 127),
            shipping_preference: 'NO_SHIPPING',
            user_action: 'PAY_NOW',
            landing_page: 'NO_PREFERENCE',
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    };
  }

  /** POST /v2/checkout/orders */
  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    return this.request<PayPalOrder>('POST', '/v2/checkout/orders', {
      body: JSON.stringify(this.buildOrderBody(input)),
      requestId: input.requestId ?? randomUUID(),
    });
  }

  /** GET /v2/checkout/orders/{id} */
  async getOrder(orderId: string): Promise<PayPalOrder> {
    return this.request<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * POST /v2/checkout/orders/{id}/capture
   *
   * Idempotent: the PayPal-Request-Id is derived from the order ID, so a
   * retried capture (double click, webhook-driven recovery) returns the
   * original result. If the order was already captured, the order is fetched
   * and returned instead of surfacing an error.
   */
  async captureOrder(orderId: string): Promise<PayPalOrder> {
    try {
      return await this.request<PayPalOrder>(
        'POST',
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        { requestId: `capture-${orderId}` },
      );
    } catch (error) {
      if (error instanceof PayPalApiError && error.issue === 'ORDER_ALREADY_CAPTURED') {
        return this.getOrder(orderId);
      }
      throw error;
    }
  }

  /**
   * Verify a webhook with PayPal's verify-webhook-signature API.
   *
   * The raw request body is spliced into the verification payload verbatim
   * rather than re-serialised from a parsed object: re-serialising can change
   * number formatting or key order and make a genuine event fail verification.
   */
  async verifyWebhookSignature(headers: WebhookHeaders, rawBody: string): Promise<boolean> {
    if (!this.options.webhookId) {
      throw new Error('PAYPAL_WEBHOOK_ID is not configured; cannot verify webhooks.');
    }
    const required = [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time',
    ] as const;
    if (required.some((name) => !headers[name])) return false;

    const envelope = JSON.stringify({
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: this.options.webhookId,
    });
    const body = `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`;

    const result = await this.request<{ verification_status?: string }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      { body },
    );
    return result.verification_status === 'SUCCESS';
  }
}

/** Pull the first capture out of an order response, if any. */
export function firstCapture(order: PayPalOrder): PayPalCapture | null {
  return order.purchase_units?.[0]?.payments?.captures?.[0] ?? null;
}
