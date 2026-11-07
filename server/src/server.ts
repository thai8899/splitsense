/**
 * HTTP API for SplitSense (Express 5).
 *
 *   POST /api/ai/process            receipt + names + description -> AI split (NDJSON progress stream)
 *   GET  /api/bills/:id             host view of a bill (admin token)
 *   POST /api/bills/:id/allocate    re-run the AI allocation with a new description (admin)
 *   PUT  /api/bills/:id/assignments manual edits to who-had-what (admin)
 *   POST /api/bills/:id/finalize    lock the split and create payment links (admin)
 *   GET  /api/bills/:id/events      live share status updates via SSE (admin)
 *   GET  /api/shares/:id            what one person owes (public, unguessable ID)
 *   POST /api/payments/create-order PayPal Orders v2 create for a share
 *   POST /api/payments/capture-order PayPal Orders v2 capture after buyer approval
 *   POST /api/webhooks/paypal       verified PayPal webhook receiver
 *
 * `createApp` takes its dependencies as arguments so tests can inject fakes.
 */
import Anthropic from '@anthropic-ai/sdk';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentUserError, type AgentStage, type ReceiptMediaType, type SplitAgent } from './ai_agent.js';
import {
  billView,
  buildShares,
  hashAdminToken,
  newId,
  orderInputForShare,
  shareView,
  splitForBill,
  verifyAdminToken,
} from './bills.js';
import type { AppConfig } from './config.js';
import { PAID_STATUSES, type BillRecord, type ShareRecord, type ShareStatus, type Store } from './db.js';
import type { EventHub } from './events.js';
import { centsToDecimal, toCents, type ItemAssignment, type TipOverride } from './money.js';
import { firstCapture, PayPalApiError, type PayPalClient, type WebhookHeaders } from './paypal.js';

export interface AppDeps {
  config: AppConfig;
  store: Store;
  paypal: Pick<PayPalClient, 'createOrder' | 'captureOrder' | 'getOrder' | 'verifyWebhookSignature'>;
  agent: Pick<SplitAgent, 'extractReceipt' | 'allocate'>;
  hub: EventHub;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const SAMPLE_RECEIPT = fileURLToPath(new URL('../../samples/sample-receipt.png', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Identify the file type from its magic bytes; never trust the client's MIME type. */
export function sniffMediaType(buffer: Buffer): ReceiptMediaType | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

/** Turn an Anthropic API failure into a message that tells the host what to fix. */
export function describeAiError(error: unknown, model: string): string {
  if (error instanceof Anthropic.APIError) {
    const detail = String(error.message ?? '').toLowerCase();
    if (error.status === 401) return 'The AI key was rejected. Check AI_API_KEY in your .env file, then restart the server.';
    if (error.status === 403) return 'This AI key is not allowed to use the API. Check the key\'s permissions in the Anthropic console.';
    if (error.status === 404) return `The AI model "${model}" is not available to this key. Set AI_MODEL in .env to a model your account can use.`;
    if (detail.includes('credit balance')) return 'Your Anthropic account has no credits left. Add credits in the Anthropic console (Plans & Billing).';
    if (error.status === 429) return 'The AI rate limit was reached. Wait a minute and try again.';
    if (error.status === 529 || (error.status ?? 0) >= 500) return 'The AI service is busy right now. Try again in a moment.';
    if (error.status === 400) return `The AI request was rejected: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) return 'Could not reach the AI service. Check your internet connection.';
  return 'The AI step failed. Please try again.';
}

/** Tiny fixed-window rate limiter keyed by client IP; protects the paid AI endpoint. */
function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const nowMs = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < nowMs) {
      hits.set(key, { count: 1, resetAt: nowMs + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) return next(new HttpError(429, 'Too many receipts processed. Please wait a minute.'));
    return next();
  };
}

const nameSchema = z.string().trim().min(1, 'Names cannot be empty').max(40, 'Names must be 40 characters or fewer');

const ProcessFieldsSchema = z.object({
  title: z.string().trim().max(80).default(''),
  hostName: nameSchema,
  friends: z
    .string()
    .transform((raw, ctx) => {
      try {
        const value: unknown = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',');
        return z.array(z.string()).parse(value).map((s) => s.trim()).filter(Boolean);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'friends must be a JSON array or comma-separated list' });
        return z.NEVER;
      }
    })
    .pipe(z.array(nameSchema).min(1, 'Add at least one friend').max(11, 'Up to 12 people per bill')),
  instructions: z.string().trim().max(2000).default(''),
  useSample: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const AssignmentsSchema = z.object({
  assignments: z
    .array(
      z.object({
        itemId: z.string(),
        shares: z.array(z.object({ participant: z.string(), weight: z.number().positive().max(1000) })),
        reason: z.string().max(200).optional(),
      }),
    )
    .max(500),
  tip: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('receipt') }),
    z.object({ mode: z.literal('percent'), value: z.number().min(0).max(100) }),
    z.object({ mode: z.literal('amount'), value: z.number().min(0).max(100000) }),
  ]),
});

const CreateOrderSchema = z.object({ shareId: z.string().min(8).max(64) });
const CaptureOrderSchema = z.object({ shareId: z.string().min(8).max(64), orderId: z.string().min(5).max(64) });

const WebhookEventSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  resource: z
    .object({
      id: z.string().optional(),
      status: z.string().optional(),
      custom_id: z.string().optional(),
      amount: z.object({ currency_code: z.string(), value: z.string() }).optional(),
      create_time: z.string().optional(),
      supplementary_data: z
        .object({ related_ids: z.object({ order_id: z.string().optional() }).partial().optional() })
        .partial()
        .optional(),
    })
    .passthrough(),
});

type WebhookEvent = z.infer<typeof WebhookEventSchema>;

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

function isUniqueNames(names: string[]): boolean {
  return new Set(names.map((n) => n.toLowerCase())).size === names.length;
}

/* ------------------------------------------------------------------------ */
/* App                                                                       */
/* ------------------------------------------------------------------------ */

export function createApp(deps: AppDeps): express.Express {
  const { config, store, paypal, agent, hub } = deps;
  const log = deps.logger ?? console;
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(self), microphone=()',
    });
    next();
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 },
  });

  const loadBill = (id: string): BillRecord => {
    const bill = store.getBill(id);
    if (!bill) throw new HttpError(404, 'Bill not found');
    return bill;
  };

  const requireAdmin = (req: Request): BillRecord => {
    const bill = loadBill(String(req.params.id));
    const token = req.get('x-admin-token') ?? (typeof req.query.token === 'string' ? req.query.token : undefined);
    if (!verifyAdminToken(token, bill.adminTokenHash, config.APP_SECRET)) {
      throw new HttpError(403, 'This link is missing a valid host token.');
    }
    return bill;
  };

  const publishShare = (share: ShareRecord) =>
    hub.publish({ type: 'share_updated', billId: share.billId, shareId: share.id, status: share.status });

  /* ---------------------------- Webhook (raw body) ---------------------------- */

  // Registered before express.json(): signature verification needs the exact bytes PayPal sent.
  app.post(
    '/api/webhooks/paypal',
    express.raw({ type: '*/*', limit: '1mb' }),
    asyncRoute(async (req, res) => {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      let event: WebhookEvent;
      try {
        event = WebhookEventSchema.parse(JSON.parse(raw));
      } catch {
        throw new HttpError(400, 'Malformed webhook payload');
      }

      const skipVerify = config.PAYPAL_WEBHOOK_SKIP_VERIFY && config.NODE_ENV !== 'production';
      if (!skipVerify) {
        const headers: WebhookHeaders = {
          'paypal-auth-algo': req.get('paypal-auth-algo'),
          'paypal-cert-url': req.get('paypal-cert-url'),
          'paypal-transmission-id': req.get('paypal-transmission-id'),
          'paypal-transmission-sig': req.get('paypal-transmission-sig'),
          'paypal-transmission-time': req.get('paypal-transmission-time'),
        };
        const verified = await paypal.verifyWebhookSignature(headers, raw);
        if (!verified) {
          log.warn(`[webhook] signature verification failed for ${event.id} (${event.event_type})`);
          throw new HttpError(400, 'Webhook signature verification failed');
        }
      }

      if (!store.recordWebhookEvent(event.id, event.event_type, event.resource.id ?? null)) {
        res.json({ received: true, duplicate: true });
        return;
      }

      try {
        const outcome = await handleWebhookEvent(event);
        log.info(`[webhook] ${event.event_type} ${event.id}: ${outcome}`);
        res.json({ received: true, outcome });
      } catch (error) {
        // Let PayPal retry: forget the event so the retry is not treated as a duplicate.
        store.forgetWebhookEvent(event.id);
        throw error;
      }
    }),
  );

  async function handleWebhookEvent(event: WebhookEvent): Promise<string> {
    const resource = event.resource;
    const findShare = (): ShareRecord | null => {
      if (resource.custom_id) {
        const byCustom = store.getShare(resource.custom_id);
        if (byCustom) return byCustom;
      }
      const orderId = resource.supplementary_data?.related_ids?.order_id;
      return orderId ? store.getShareByOrderId(orderId) : null;
    };

    switch (event.event_type) {
      case 'CHECKOUT.ORDER.APPROVED': {
        const share = resource.id ? store.getShareByOrderId(resource.id) : null;
        if (!share) return 'ignored: unknown order';
        if (share.status !== 'order_created') return `no-op: share is ${share.status}`;
        publishShare(store.updateSharePayment(share.id, { status: 'approved' }));
        // Recovery path: if the buyer closed the tab before our capture call ran,
        // capture server-side. Same PayPal-Request-Id as the client path, so this is idempotent.
        await capturePaidShare(share.id, resource.id!);
        return 'approved and captured';
      }
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const share = findShare();
        if (!share) return 'ignored: unknown share';
        const expected = centsToDecimal(share.amountCents);
        if (resource.amount && (resource.amount.value !== expected || resource.amount.currency_code !== share.currency)) {
          log.error(
            `[webhook] amount mismatch on share ${share.id}: expected ${expected} ${share.currency}, got ${resource.amount.value} ${resource.amount.currency_code}`,
          );
          publishShare(store.updateSharePayment(share.id, { status: 'pending', captureId: resource.id ?? null }));
          return 'flagged: amount mismatch';
        }
        publishShare(
          store.updateSharePayment(share.id, {
            status: 'completed',
            captureId: resource.id ?? share.captureId,
            webhookVerified: true,
            paidAt: share.paidAt ?? resource.create_time ?? new Date().toISOString(),
          }),
        );
        return 'share completed';
      }
      case 'PAYMENT.CAPTURE.PENDING': {
        const share = findShare();
        if (!share || share.status === 'completed') return 'no-op';
        publishShare(store.updateSharePayment(share.id, { status: 'pending', captureId: resource.id ?? null }));
        return 'share pending';
      }
      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.DECLINED': {
        const share = findShare();
        if (!share) return 'ignored: unknown share';
        publishShare(store.updateSharePayment(share.id, { status: 'failed', paidAt: null }));
        return 'share failed';
      }
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        const share = findShare();
        if (!share) return 'ignored: unknown share';
        publishShare(store.updateSharePayment(share.id, { status: 'refunded' }));
        return 'share refunded';
      }
      default:
        return 'ignored: unhandled event type';
    }
  }

  /** Capture an approved order and record the result. Shared by the API route and webhook recovery. */
  async function capturePaidShare(shareId: string, orderId: string) {
    const order = await paypal.captureOrder(orderId);
    const capture = firstCapture(order);
    const current = store.getShare(shareId)!;
    const payerName = [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ') || null;
    const payerEmail = order.payer?.email_address ?? null;

    let status: ShareStatus;
    if (order.status === 'COMPLETED' && capture?.status === 'COMPLETED') {
      const amountOk =
        capture.amount.value === centsToDecimal(current.amountCents) && capture.amount.currency_code === current.currency;
      status = amountOk ? 'captured' : 'pending';
      if (!amountOk) log.error(`[capture] amount mismatch on share ${shareId}`);
    } else if (capture?.status === 'PENDING') {
      status = 'pending';
    } else {
      status = 'failed';
    }
    // Never downgrade a share the webhook already confirmed.
    if (current.status === 'completed' && status === 'captured') status = 'completed';

    const updated = store.updateSharePayment(shareId, {
      status,
      captureId: capture?.id ?? null,
      payerName,
      payerEmail,
      paidAt: PAID_STATUSES.has(status) ? (current.paidAt ?? new Date().toISOString()) : null,
    });
    publishShare(updated);
    return { order, capture, share: updated };
  }

  /* ---------------------------- JSON API ---------------------------- */

  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, paypal: config.PAYPAL_API_BASE_URL.includes('sandbox') ? 'sandbox' : 'live', model: config.AI_MODEL });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      paypalClientId: config.PAYPAL_CLIENT_ID,
      environment: config.PAYPAL_API_BASE_URL.includes('sandbox') ? 'sandbox' : 'live',
      aiModel: config.AI_MODEL,
      sampleReceiptAvailable: existsSync(SAMPLE_RECEIPT),
    });
  });

  app.get('/api/sample-receipt', (_req, res) => {
    if (!existsSync(SAMPLE_RECEIPT)) throw new HttpError(404, 'Sample receipt is not bundled with this build.');
    res.type('png').sendFile(SAMPLE_RECEIPT);
  });

  app.post(
    '/api/ai/process',
    rateLimit(10, 60_000),
    upload.single('receipt'),
    asyncRoute(async (req, res) => {
      const fields = ProcessFieldsSchema.parse(req.body ?? {});
      const participants = [fields.hostName, ...fields.friends];
      if (!isUniqueNames(participants)) throw new HttpError(400, 'Each person needs a unique name.');

      let data: Buffer;
      if (fields.useSample) {
        if (!existsSync(SAMPLE_RECEIPT)) throw new HttpError(404, 'Sample receipt is not bundled with this build.');
        data = readFileSync(SAMPLE_RECEIPT);
      } else if (req.file) {
        data = req.file.buffer;
      } else {
        throw new HttpError(400, 'Attach a receipt photo, or use the sample receipt.');
      }
      const mediaType = sniffMediaType(data);
      if (!mediaType) throw new HttpError(415, 'Upload a JPEG, PNG, WebP, GIF or PDF receipt.');

      // From here on, progress is streamed as NDJSON so the UI can show each agent step live.
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const send = (payload: Record<string, unknown>) => res.write(`${JSON.stringify(payload)}\n`);
      const progress = (stage: AgentStage, message: string) => send({ type: 'progress', stage, message });

      try {
        const extraction = await agent.extractReceipt({ data, mediaType }, progress);
        const allocation = await agent.allocate(extraction.receipt, participants, fields.hostName, fields.instructions, progress);
        progress('computing_shares', 'Calculating everyone’s exact share…');

        const adminToken = newId(24);
        const bill = store.insertBill({
          id: newId(9),
          adminTokenHash: hashAdminToken(adminToken, config.APP_SECRET),
          title: fields.title || `${extraction.receipt.merchant} split`,
          hostName: fields.hostName,
          participants,
          receipt: extraction.receipt,
          assignments: allocation.assignments,
          tipOverride: allocation.tipOverride,
          instructions: fields.instructions,
          notes: [...extraction.notes, ...allocation.notes.map((n) => `[split] ${n}`)],
        });
        send({
          type: 'result',
          billId: bill.id,
          adminToken,
          bill: billView(bill, [], config.APP_BASE_URL),
          ai: { extractionAttempts: extraction.attempts, allocationAttempts: allocation.attempts, model: config.AI_MODEL },
        });
      } catch (error) {
        const message = error instanceof AgentUserError ? error.message : describeAiError(error, config.AI_MODEL);
        if (!(error instanceof AgentUserError)) log.error('[ai/process]', error);
        send({ type: 'error', error: message });
      } finally {
        res.end();
      }
    }),
  );

  app.get('/api/bills/:id', (req, res) => {
    const bill = requireAdmin(req);
    res.json(billView(bill, store.listShares(bill.id), config.APP_BASE_URL));
  });

  app.post(
    '/api/bills/:id/allocate',
    rateLimit(20, 60_000),
    asyncRoute(async (req, res) => {
      const bill = requireAdmin(req);
      if (bill.status !== 'draft') throw new HttpError(409, 'This bill is already finalized.');
      const { instructions } = z.object({ instructions: z.string().trim().max(2000) }).parse(req.body);
      try {
        const allocation = await agent.allocate(bill.receipt, bill.participants, bill.hostName, instructions);
        const extractionNotes = bill.notes.filter((n) => !n.startsWith('[split]'));
        const updated = store.updateAllocation(bill.id, {
          assignments: allocation.assignments,
          tipOverride: allocation.tipOverride,
          instructions,
          notes: [...extractionNotes, ...allocation.notes.map((n) => `[split] ${n}`)],
        });
        res.json(billView(updated, [], config.APP_BASE_URL));
      } catch (error) {
        if (error instanceof AgentUserError) throw new HttpError(422, error.message);
        log.error('[ai/allocate]', error);
        throw new HttpError(502, describeAiError(error, config.AI_MODEL));
      }
    }),
  );

  app.put('/api/bills/:id/assignments', (req, res) => {
    const bill = requireAdmin(req);
    if (bill.status !== 'draft') throw new HttpError(409, 'This bill is already finalized.');
    const body = AssignmentsSchema.parse(req.body);
    const itemIds = new Set(bill.receipt.items.map((i) => i.id));
    const people = new Set(bill.participants);
    const assignments: ItemAssignment[] = body.assignments
      .filter((a) => itemIds.has(a.itemId))
      .map((a) => ({
        itemId: a.itemId,
        shares: a.shares.filter((s) => people.has(s.participant)),
        reason: a.reason ?? 'Edited manually',
      }));
    const tipOverride: TipOverride | null =
      body.tip.mode === 'receipt'
        ? null
        : body.tip.mode === 'percent'
          ? { mode: 'percent', value: body.tip.value }
          : { mode: 'amount', valueCents: toCents(body.tip.value) };
    const updated = store.updateAllocation(bill.id, { assignments, tipOverride });
    res.json(billView(updated, [], config.APP_BASE_URL));
  });

  app.post('/api/bills/:id/finalize', (req, res) => {
    const bill = requireAdmin(req);
    if (bill.status !== 'draft') throw new HttpError(409, 'This bill is already finalized.');
    const split = splitForBill(bill);
    if (split.unassignedItemIds.length > 0) {
      throw new HttpError(400, 'Every item needs at least one person before payment links can be created.', {
        unassignedItemIds: split.unassignedItemIds,
      });
    }
    const shares = store.finalizeBill(bill.id, buildShares(bill, split));
    hub.publish({ type: 'bill_updated', billId: bill.id });
    res.json(billView(store.getBill(bill.id)!, shares, config.APP_BASE_URL));
  });

  app.get('/api/bills/:id/events', (req, res) => {
    const bill = requireAdmin(req);
    const unsubscribe = hub.subscribe(bill.id, res);
    req.on('close', unsubscribe);
  });

  app.get('/api/shares/:id', (req, res) => {
    const share = store.getShare(String(req.params.id));
    if (!share) throw new HttpError(404, 'Payment link not found');
    const bill = loadBill(share.billId);
    res.json({
      share: shareView(share, config.APP_BASE_URL),
      bill: {
        title: bill.title,
        hostName: bill.hostName,
        merchant: bill.receipt.merchant,
        date: bill.receipt.date,
        partySize: bill.participants.length,
      },
    });
  });

  app.post(
    '/api/payments/create-order',
    asyncRoute(async (req, res) => {
      const { shareId } = CreateOrderSchema.parse(req.body);
      const share = store.getShare(shareId);
      if (!share) throw new HttpError(404, 'Payment link not found');
      if (share.status === 'host') throw new HttpError(409, 'The host does not need to pay their own share.');
      if (['approved', 'captured', 'completed', 'pending'].includes(share.status)) {
        throw new HttpError(409, 'This share has already been paid.', { status: share.status });
      }
      const bill = loadBill(share.billId);
      // Amounts come from the stored split, never from the browser.
      const order = await paypal.createOrder(orderInputForShare(bill, share, config.APP_BASE_URL));
      const updated = store.updateSharePayment(share.id, { status: 'order_created', paypalOrderId: order.id });
      publishShare(updated);
      res.status(201).json({ id: order.id, status: order.status });
    }),
  );

  app.post(
    '/api/payments/capture-order',
    asyncRoute(async (req, res) => {
      const { shareId, orderId } = CaptureOrderSchema.parse(req.body);
      const share = store.getShare(shareId);
      if (!share) throw new HttpError(404, 'Payment link not found');
      if (share.paypalOrderId !== orderId) throw new HttpError(400, 'Order does not belong to this payment link.');
      if (PAID_STATUSES.has(share.status)) {
        res.json({ status: 'COMPLETED', captureId: share.captureId, share: shareView(share, config.APP_BASE_URL) });
        return;
      }
      try {
        const { capture, share: updated } = await capturePaidShare(shareId, orderId);
        if (updated.status === 'failed') {
          throw new HttpError(402, 'PayPal declined this payment. Please try another funding source.', {
            issue: 'INSTRUMENT_DECLINED',
          });
        }
        res.json({
          status: updated.status === 'pending' ? 'PENDING' : 'COMPLETED',
          captureId: capture?.id ?? null,
          share: shareView(updated, config.APP_BASE_URL),
        });
      } catch (error) {
        if (error instanceof PayPalApiError && error.issue === 'INSTRUMENT_DECLINED') {
          throw new HttpError(422, 'Your payment method was declined. Please choose another.', {
            issue: 'INSTRUMENT_DECLINED',
            debugId: error.debugId,
          });
        }
        throw error;
      }
    }),
  );

  /* ---------------------------- Static frontend ---------------------------- */

  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(`${WEB_DIST}/index.html`);
    });
  }

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  /* ---------------------------- Errors ---------------------------- */

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message, ...error.extra });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? `Receipt must be under ${config.MAX_UPLOAD_MB} MB.` : error.message;
      res.status(400).json({ error: message });
      return;
    }
    if (error instanceof PayPalApiError) {
      log.error(`[paypal] ${error.message} debug_id=${error.debugId ?? 'n/a'}`);
      res.status(502).json({ error: 'PayPal could not process the request. Please try again.', issue: error.issue, debugId: error.debugId });
      return;
    }
    log.error('[unhandled]', error);
    res.status(500).json({ error: 'Something went wrong on our side.' });
  });

  return app;
}
