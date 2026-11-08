import { describe, expect, it, vi } from 'vitest';
import { PayPalApiError, PayPalClient } from '../src/paypal.js';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function makeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const client = new PayPalClient({
    clientId: 'cid',
    clientSecret: 'secret',
    baseUrl: 'https://api-m.sandbox.paypal.com',
    webhookId: 'WH-123',
    brandName: 'SplitSense',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { client, fetchImpl };
}

describe('PayPalClient OAuth', () => {
  it('caches the token and deduplicates concurrent requests', async () => {
    let tokenCalls = 0;
    const { client } = makeClient(async (url, init) => {
      if (url.endsWith('/v1/oauth2/token')) {
        tokenCalls += 1;
        expect(init.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('cid:secret').toString('base64')}` });
        expect(init.body).toBe('grant_type=client_credentials');
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { access_token: 'A21', expires_in: 32400 });
      }
      throw new Error(`unexpected ${url}`);
    });
    const tokens = await Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
    expect(tokens).toEqual(['A21', 'A21', 'A21']);
    await client.getAccessToken();
    expect(tokenCalls).toBe(1);
  });

  it('refreshes once and retries when PayPal returns 401', async () => {
    let tokenCalls = 0;
    let orderCalls = 0;
    const { client } = makeClient((url) => {
      if (url.endsWith('/v1/oauth2/token')) {
        tokenCalls += 1;
        return json(200, { access_token: `T${tokenCalls}`, expires_in: 32400 });
      }
      orderCalls += 1;
      return orderCalls === 1 ? json(401, { name: 'INVALID_TOKEN' }) : json(200, { id: 'ORDER1', status: 'CREATED' });
    });
    const order = await client.getOrder('ORDER1');
    expect(order.id).toBe('ORDER1');
    expect(tokenCalls).toBe(2);
  });

  it('surfaces OAuth failures as PayPalApiError', async () => {
    const { client } = makeClient(() => json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }));
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(PayPalApiError);
  });
});

describe('PayPalClient orders', () => {
  it('builds a balanced Orders v2 body with breakdown and items', () => {
    const { client } = makeClient(() => json(200, {}));
    const body = client.buildOrderBody({
      referenceId: 'share123',
      currency: 'USD',
      description: "Ada's share",
      items: [
        { name: 'Grilled Salmon', amountCents: 2400 },
        { name: 'Chicken Wings (1/2 share)', amountCents: 800 },
        { name: 'Tip (your share)', amountCents: 640 },
      ],
      taxCents: 275,
      handlingCents: 100,
      discountCents: 50,
      returnUrl: 'https://x/pay/share123?result=approved',
      cancelUrl: 'https://x/pay/share123?result=cancelled',
    }) as any;
    const unit = body.purchase_units[0];
    expect(body.intent).toBe('CAPTURE');
    expect(unit.custom_id).toBe('share123');
    expect(unit.amount.value).toBe('41.65');
    expect(unit.amount.breakdown).toEqual({
      item_total: { currency_code: 'USD', value: '38.40' },
      tax_total: { currency_code: 'USD', value: '2.75' },
      handling: { currency_code: 'USD', value: '1.00' },
      discount: { currency_code: 'USD', value: '0.50' },
    });
    const itemSum = unit.items.reduce((s: number, i: any) => s + Math.round(Number(i.unit_amount.value) * 100) * Number(i.quantity), 0);
    expect(itemSum).toBe(3840);
    expect(body.payment_source.paypal.experience_context.shipping_preference).toBe('NO_SHIPPING');
  });

  it('routes money to the host when a payee email is given', () => {
    const { client } = makeClient(() => json(200, {}));
    const base = { referenceId: 's1', currency: 'USD', description: 'd', items: [{ name: 'x', amountCents: 500 }], taxCents: 0, handlingCents: 0, discountCents: 0, returnUrl: 'r', cancelUrl: 'c' };
    const direct = client.buildOrderBody({ ...base, payeeEmail: 'host@example.com' }) as any;
    expect(direct.purchase_units[0].payee).toEqual({ email_address: 'host@example.com' });
    const merchant = client.buildOrderBody(base) as any;
    expect(merchant.purchase_units[0].payee).toBeUndefined();
  });

  it('sends idempotency headers and returns the order on capture', async () => {
    const seen: Record<string, string>[] = [];
    const { client } = makeClient((url, init) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'T', expires_in: 3600 });
      seen.push(init.headers as Record<string, string>);
      return json(201, { id: 'O1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'C1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '1.00' } }] } }] });
    });
    const order = await client.captureOrder('O1');
    expect(order.status).toBe('COMPLETED');
    expect(seen[0]['PayPal-Request-Id']).toBe('capture-O1');
  });

  it('treats ORDER_ALREADY_CAPTURED as success by fetching the order', async () => {
    const { client } = makeClient((url, init) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'T', expires_in: 3600 });
      if (init.method === 'POST') return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }], debug_id: 'dbg' });
      return json(200, { id: 'O1', status: 'COMPLETED' });
    });
    await expect(client.captureOrder('O1')).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('raises typed errors with issue and debug id', async () => {
    const { client } = makeClient((url) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'T', expires_in: 3600 });
      return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED', description: 'declined' }], debug_id: 'abc123' });
    });
    const error = await client.captureOrder('O1').catch((e) => e);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error.issue).toBe('INSTRUMENT_DECLINED');
    expect(error.debugId).toBe('abc123');
  });
});

describe('PayPalClient webhook verification', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT',
    'paypal-transmission-id': 'tid',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-11-06T00:00:00Z',
  };

  it('splices the raw body verbatim into the verification request', async () => {
    const raw = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"10.50"}},"n":1.0}';
    let sentBody = '';
    const { client } = makeClient((url, init) => {
      if (url.endsWith('/token')) return json(200, { access_token: 'T', expires_in: 3600 });
      sentBody = String(init.body);
      return json(200, { verification_status: 'SUCCESS' });
    });
    await expect(client.verifyWebhookSignature(headers, raw)).resolves.toBe(true);
    expect(sentBody.endsWith(`"webhook_event":${raw}}`)).toBe(true);
    expect(JSON.parse(sentBody)).toMatchObject({ webhook_id: 'WH-123', transmission_id: 'tid' });
  });

  it('returns false for FAILURE and for missing headers', async () => {
    const { client, fetchImpl } = makeClient((url) =>
      url.endsWith('/token') ? json(200, { access_token: 'T', expires_in: 3600 }) : json(200, { verification_status: 'FAILURE' }),
    );
    await expect(client.verifyWebhookSignature(headers, '{}')).resolves.toBe(false);
    const calls = fetchImpl.mock.calls.length;
    await expect(client.verifyWebhookSignature({}, '{}')).resolves.toBe(false);
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
});
