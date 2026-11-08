import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SplitAgent } from '../src/ai_agent.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { EventHub } from '../src/events.js';
import { centsToDecimal } from '../src/money.js';
import type { CreateOrderInput, PayPalOrder } from '../src/paypal.js';
import { createApp, sniffMediaType } from '../src/server.js';
import { SAMPLE_ALLOCATION, SAMPLE_EXTRACTION, scriptedAnthropic } from './fakes.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PAYPAL_CLIENT_ID: 'cid',
  PAYPAL_CLIENT_SECRET: 'secret',
  PAYPAL_WEBHOOK_ID: 'WH-1',
  AI_API_KEY: 'sk-test',
  APP_SECRET: 'test-secret-at-least-16',
  APP_BASE_URL: 'https://splitsense.test',
  DATABASE_PATH: ':memory:',
});

/** In-memory PayPal fake that behaves like the sandbox for the happy path. */
class FakePayPal {
  orders = new Map<string, { input: CreateOrderInput; status: PayPalOrder['status'] }>();
  verify = true;
  declineNext = false;
  async createOrder(input: CreateOrderInput): Promise<PayPalOrder> {
    const id = `ORDER${this.orders.size + 1}`;
    this.orders.set(id, { input, status: 'CREATED' });
    return { id, status: 'CREATED' };
  }
  async captureOrder(orderId: string): Promise<PayPalOrder> {
    const order = this.orders.get(orderId)!;
    const items = order.input.items.reduce((s, i) => s + i.amountCents, 0);
    const total = items + order.input.taxCents + order.input.handlingCents - order.input.discountCents;
    const status = this.declineNext ? 'DECLINED' : 'COMPLETED';
    order.status = 'COMPLETED';
    return {
      id: orderId,
      status: 'COMPLETED',
      payer: { name: { given_name: 'Sandbox', surname: 'Buyer' }, email_address: 'buyer@example.com' },
      purchase_units: [{ payments: { captures: [{ id: `CAP-${orderId}`, status, amount: { currency_code: 'USD', value: centsToDecimal(total) }, custom_id: order.input.referenceId }] } }],
    };
  }
  async getOrder(orderId: string): Promise<PayPalOrder> {
    return { id: orderId, status: this.orders.get(orderId)!.status };
  }
  async verifyWebhookSignature(): Promise<boolean> {
    return this.verify;
  }
}

let store: Store;
let hub: EventHub;
let paypal: FakePayPal;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(':memory:');
  hub = new EventHub(60_000);
  paypal = new FakePayPal();
  const agent = new SplitAgent(scriptedAnthropic([SAMPLE_EXTRACTION, SAMPLE_ALLOCATION]), {
    model: 'claude-sonnet-5-5',
    maxRetries: 2,
    defaultCurrency: 'USD',
  });
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  app = createApp({ config, store, paypal, agent, hub, logger: silent });
});
afterEach(() => {
  hub.close();
  store.close();
});

function parseNdjson(text: string) {
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

async function createBill() {
  const res = await request(app)
    .post('/api/ai/process')
    .field('hostName', 'Femi')
    .field('friends', JSON.stringify(['Ada', 'Tolu', 'Kemi']))
    .field('instructions', 'Ada and I split the wings… add 20% tip')
    .field('useSample', 'true');
  expect(res.status).toBe(200);
  const lines = parseNdjson(res.text);
  const result = lines.find((l) => l.type === 'result');
  return { lines, result };
}

const webhook = (body: unknown) =>
  request(app)
    .post('/api/webhooks/paypal')
    .set('content-type', 'application/json')
    .set('paypal-transmission-id', 't')
    .send(JSON.stringify(body));

describe('file sniffing', () => {
  it('detects formats from magic bytes', () => {
    expect(sniffMediaType(Buffer.from('%PDF-1.7 xxxxxxxx'))).toBe('application/pdf');
    expect(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(sniffMediaType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
  });
});

describe('SplitSense API end to end', () => {
  it('streams AI progress and stores a draft bill', async () => {
    const { lines, result } = await createBill();
    expect(lines.filter((l) => l.type === 'progress').map((l) => l.stage)).toEqual(
      expect.arrayContaining(['reading_receipt', 'verifying_math', 'assigning_items', 'computing_shares']),
    );
    expect(result.bill.status).toBe('draft');
    expect(result.bill.split.tipCents).toBe(2360);
    const total = result.bill.split.people.reduce((s: number, p: any) => s + p.totalCents, 0);
    expect(total).toBe(12815 + 2360);
  });

  it('stores the host PayPal email and sends it as the order payee', async () => {
    const res = await request(app)
      .post('/api/ai/process')
      .field('hostName', 'Femi')
      .field('hostPayPalEmail', ' Femi@Example.com ')
      .field('friends', JSON.stringify(['Ada', 'Tolu', 'Kemi']))
      .field('useSample', 'true');
    const result = parseNdjson(res.text).find((l) => l.type === 'result');
    expect(result.bill.hostPayPalEmail).toBe('femi@example.com');
    const fin = await request(app).post(`/api/bills/${result.billId}/finalize`).set('x-admin-token', result.adminToken);
    const ada = fin.body.shares.find((s: any) => s.participant === 'Ada');
    expect((await request(app).get(`/api/shares/${ada.id}`)).body.bill.paysHostDirectly).toBe(true);
    const created = await request(app).post('/api/payments/create-order').send({ shareId: ada.id });
    expect(paypal.orders.get(created.body.id)!.input.payeeEmail).toBe('femi@example.com');

    const bad = await request(app).post('/api/ai/process').field('hostName', 'A').field('hostPayPalEmail', 'not-an-email').field('friends', 'B').field('useSample', 'true');
    expect(bad.status).toBe(400);
  });

  it('rejects requests without a valid admin token', async () => {
    const { result } = await createBill();
    expect((await request(app).get(`/api/bills/${result.billId}`)).status).toBe(403);
    expect((await request(app).get(`/api/bills/${result.billId}`).set('x-admin-token', 'nope')).status).toBe(403);
    expect((await request(app).get(`/api/bills/${result.billId}`).set('x-admin-token', result.adminToken)).status).toBe(200);
  });

  it('validates input', async () => {
    const dup = await request(app).post('/api/ai/process').field('hostName', 'Ada').field('friends', 'ada').field('useSample', 'true');
    expect(dup.status).toBe(400);
    const noFile = await request(app).post('/api/ai/process').field('hostName', 'Ada').field('friends', 'Bo');
    expect(noFile.status).toBe(400);
    const badFile = await request(app)
      .post('/api/ai/process')
      .field('hostName', 'Ada')
      .field('friends', 'Bo')
      .attach('receipt', Buffer.from('<svg>not a receipt image at all</svg>'), 'r.png');
    expect(badFile.status).toBe(415);
  });

  it('runs the full pay flow: finalize -> create order -> capture -> webhook confirmation', async () => {
    const { result } = await createBill();
    const auth = { 'x-admin-token': result.adminToken };

    const edited = await request(app)
      .put(`/api/bills/${result.billId}/assignments`)
      .set(auth)
      .send({ assignments: result.bill.assignments, tip: { mode: 'percent', value: 18 } });
    expect(edited.status).toBe(200);
    expect(edited.body.split.tipCents).toBe(2124);

    const finalized = await request(app).post(`/api/bills/${result.billId}/finalize`).set(auth);
    expect(finalized.status).toBe(200);
    const shares = finalized.body.shares as any[];
    expect(shares).toHaveLength(4);
    expect(shares[0]).toMatchObject({ participant: 'Femi', status: 'host' });
    const ada = shares.find((s) => s.participant === 'Ada');
    expect(ada.payUrl).toBe(`https://splitsense.test/pay/${ada.id}`);

    const pub = await request(app).get(`/api/shares/${ada.id}`);
    expect(pub.body.bill.merchant).toBe('Saguaro Social Kitchen');

    const hostPay = await request(app).post('/api/payments/create-order').send({ shareId: shares[0].id });
    expect(hostPay.status).toBe(409);

    const created = await request(app).post('/api/payments/create-order').send({ shareId: ada.id });
    expect(created.status).toBe(201);
    const orderInput = paypal.orders.get(created.body.id)!.input;
    const orderTotal = orderInput.items.reduce((s, i) => s + i.amountCents, 0) + orderInput.taxCents;
    expect(orderTotal).toBe(ada.amountCents);

    const wrongOrder = await request(app).post('/api/payments/capture-order').send({ shareId: ada.id, orderId: 'OTHER' });
    expect(wrongOrder.status).toBe(400);

    const captured = await request(app).post('/api/payments/capture-order').send({ shareId: ada.id, orderId: created.body.id });
    expect(captured.status).toBe(200);
    expect(captured.body.share).toMatchObject({ status: 'captured', paid: true, payerName: 'Sandbox Buyer' });

    const again = await request(app).post('/api/payments/create-order').send({ shareId: ada.id });
    expect(again.status).toBe(409);

    const event = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: `CAP-${created.body.id}`,
        status: 'COMPLETED',
        custom_id: ada.id,
        amount: { currency_code: 'USD', value: centsToDecimal(ada.amountCents) },
        supplementary_data: { related_ids: { order_id: created.body.id } },
      },
    };
    const hook = await webhook(event);
    expect(hook.body).toMatchObject({ received: true, outcome: 'share completed' });
    const dup = await webhook(event);
    expect(dup.body).toMatchObject({ duplicate: true });

    const bill = await request(app).get(`/api/bills/${result.billId}`).set(auth);
    const adaNow = bill.body.shares.find((s: any) => s.id === ada.id);
    expect(adaNow).toMatchObject({ status: 'completed', webhookVerified: true });
    expect(bill.body.progress).toMatchObject({ paidCount: 1, owedCount: 3, collectedCents: ada.amountCents });
  });

  it('flags webhook amount mismatches instead of marking paid', async () => {
    const { result } = await createBill();
    const fin = await request(app).post(`/api/bills/${result.billId}/finalize`).set('x-admin-token', result.adminToken);
    const tolu = fin.body.shares.find((s: any) => s.participant === 'Tolu');
    const hook = await webhook({
      id: 'WH-EVT-2',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP', custom_id: tolu.id, amount: { currency_code: 'USD', value: '0.01' } },
    });
    expect(hook.body.outcome).toBe('flagged: amount mismatch');
  });

  it('recovers via CHECKOUT.ORDER.APPROVED when the buyer closes the tab', async () => {
    const { result } = await createBill();
    const fin = await request(app).post(`/api/bills/${result.billId}/finalize`).set('x-admin-token', result.adminToken);
    const kemi = fin.body.shares.find((s: any) => s.participant === 'Kemi');
    const created = await request(app).post('/api/payments/create-order').send({ shareId: kemi.id });
    const hook = await webhook({ id: 'WH-EVT-3', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: created.body.id, status: 'APPROVED' } });
    expect(hook.body.outcome).toBe('approved and captured');
    const share = await request(app).get(`/api/shares/${kemi.id}`);
    expect(share.body.share.paid).toBe(true);
  });

  it('rejects webhooks that fail signature verification', async () => {
    paypal.verify = false;
    const res = await webhook({ id: 'X', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });
    expect(res.status).toBe(400);
  });

  it('refuses to finalize twice', async () => {
    const { result } = await createBill();
    const auth = { 'x-admin-token': result.adminToken };
    expect((await request(app).post(`/api/bills/${result.billId}/finalize`).set(auth)).status).toBe(200);
    expect((await request(app).post(`/api/bills/${result.billId}/finalize`).set(auth)).status).toBe(409);
  });
});
