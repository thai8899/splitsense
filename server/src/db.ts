/**
 * SQLite persistence using Node's built-in `node:sqlite` (synchronous, transactional).
 *
 * Built into Node 22.13+, so there is no native module to compile on any OS and
 * no database server to run: `npm install`, then `npm run dev`. Structured sub-documents (receipt,
 * assignments, breakdowns) are stored as JSON columns; anything we query or
 * update on its own (status, PayPal IDs) is a real column.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ItemAssignment, PersonBreakdown, Receipt, TipOverride } from './money.js';

export type BillStatus = 'draft' | 'finalized';

/**
 * Lifecycle of one person's share:
 *   host          the bill owner's own portion — nothing to pay
 *   awaiting      link sent, no PayPal order yet
 *   order_created PayPal order exists, buyer has not approved yet
 *   approved      buyer approved in PayPal, capture not yet confirmed
 *   captured      capture API returned COMPLETED, waiting for webhook confirmation
 *   completed     PAYMENT.CAPTURE.COMPLETED webhook verified — final
 *   pending       PayPal holds the capture for review (eCheck, risk)
 *   failed        capture denied or declined
 *   refunded      capture refunded after the fact
 */
export type ShareStatus =
  | 'host'
  | 'awaiting'
  | 'order_created'
  | 'approved'
  | 'captured'
  | 'completed'
  | 'pending'
  | 'failed'
  | 'refunded';

export const PAID_STATUSES: ReadonlySet<ShareStatus> = new Set(['captured', 'completed']);

export interface BillRecord {
  id: string;
  adminTokenHash: string;
  title: string;
  hostName: string;
  participants: string[];
  receipt: Receipt;
  assignments: ItemAssignment[];
  tipOverride: TipOverride | null;
  instructions: string;
  notes: string[];
  status: BillStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ShareRecord {
  id: string;
  billId: string;
  participant: string;
  isHost: boolean;
  amountCents: number;
  currency: string;
  breakdown: PersonBreakdown;
  status: ShareStatus;
  paypalOrderId: string | null;
  captureId: string | null;
  payerName: string | null;
  payerEmail: string | null;
  webhookVerified: boolean;
  paidAt: string | null;
  updatedAt: string;
}

interface BillRow {
  id: string;
  admin_token_hash: string;
  title: string;
  host_name: string;
  participants_json: string;
  receipt_json: string;
  assignments_json: string;
  tip_override_json: string | null;
  instructions: string;
  notes_json: string;
  status: BillStatus;
  created_at: string;
  updated_at: string;
}

interface ShareRow {
  id: string;
  bill_id: string;
  participant: string;
  is_host: number;
  amount_cents: number;
  currency: string;
  breakdown_json: string;
  status: ShareStatus;
  paypal_order_id: string | null;
  capture_id: string | null;
  payer_name: string | null;
  payer_email: string | null;
  webhook_verified: number;
  paid_at: string | null;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bills (
  id                TEXT PRIMARY KEY,
  admin_token_hash  TEXT NOT NULL,
  title             TEXT NOT NULL,
  host_name         TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  receipt_json      TEXT NOT NULL,
  assignments_json  TEXT NOT NULL,
  tip_override_json TEXT,
  instructions      TEXT NOT NULL DEFAULT '',
  notes_json        TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'draft',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  id               TEXT PRIMARY KEY,
  bill_id          TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  participant      TEXT NOT NULL,
  is_host          INTEGER NOT NULL DEFAULT 0,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  breakdown_json   TEXT NOT NULL,
  status           TEXT NOT NULL,
  paypal_order_id  TEXT,
  capture_id       TEXT,
  payer_name       TEXT,
  payer_email      TEXT,
  webhook_verified INTEGER NOT NULL DEFAULT 0,
  paid_at          TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_bill ON shares(bill_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_order ON shares(paypal_order_id) WHERE paypal_order_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  resource_id TEXT,
  received_at TEXT NOT NULL
);
`;

const now = (): string => new Date().toISOString();

function toBill(row: BillRow): BillRecord {
  return {
    id: row.id,
    adminTokenHash: row.admin_token_hash,
    title: row.title,
    hostName: row.host_name,
    participants: JSON.parse(row.participants_json) as string[],
    receipt: JSON.parse(row.receipt_json) as Receipt,
    assignments: JSON.parse(row.assignments_json) as ItemAssignment[],
    tipOverride: row.tip_override_json ? (JSON.parse(row.tip_override_json) as TipOverride) : null,
    instructions: row.instructions,
    notes: JSON.parse(row.notes_json) as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toShare(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    billId: row.bill_id,
    participant: row.participant,
    isHost: row.is_host === 1,
    amountCents: row.amount_cents,
    currency: row.currency,
    breakdown: JSON.parse(row.breakdown_json) as PersonBreakdown,
    status: row.status,
    paypalOrderId: row.paypal_order_id,
    captureId: row.capture_id,
    payerName: row.payer_name,
    payerEmail: row.payer_email,
    webhookVerified: row.webhook_verified === 1,
    paidAt: row.paid_at,
    updatedAt: row.updated_at,
  };
}

export type NewBill = Omit<BillRecord, 'createdAt' | 'updatedAt' | 'status'>;
export type NewShare = Pick<ShareRecord, 'id' | 'billId' | 'participant' | 'isHost' | 'amountCents' | 'currency' | 'breakdown' | 'status'>;

export interface SharePaymentUpdate {
  status: ShareStatus;
  paypalOrderId?: string;
  captureId?: string | null;
  payerName?: string | null;
  payerEmail?: string | null;
  webhookVerified?: boolean;
  paidAt?: string | null;
}

/** Typed repository over the SQLite file. One instance per process. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  insertBill(bill: NewBill): BillRecord {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO bills (id, admin_token_hash, title, host_name, participants_json, receipt_json,
           assignments_json, tip_override_json, instructions, notes_json, status, created_at, updated_at)
         VALUES (@id, @adminTokenHash, @title, @hostName, @participants, @receipt, @assignments,
           @tipOverride, @instructions, @notes, 'draft', @ts, @ts)`,
      )
      .run({
        id: bill.id,
        adminTokenHash: bill.adminTokenHash,
        title: bill.title,
        hostName: bill.hostName,
        participants: JSON.stringify(bill.participants),
        receipt: JSON.stringify(bill.receipt),
        assignments: JSON.stringify(bill.assignments),
        tipOverride: bill.tipOverride ? JSON.stringify(bill.tipOverride) : null,
        instructions: bill.instructions,
        notes: JSON.stringify(bill.notes),
        ts,
      });
    return this.getBill(bill.id)!;
  }

  getBill(id: string): BillRecord | null {
    const row = this.db.prepare('SELECT * FROM bills WHERE id = ?').get(id) as unknown as BillRow | undefined;
    return row ? toBill(row) : null;
  }

  updateAllocation(
    id: string,
    patch: { assignments: ItemAssignment[]; tipOverride: TipOverride | null; instructions?: string; notes?: string[] },
  ): BillRecord {
    const current = this.getBill(id);
    if (!current) throw new Error(`Bill ${id} not found`);
    this.db
      .prepare(
        `UPDATE bills SET assignments_json = ?, tip_override_json = ?, instructions = ?, notes_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(patch.assignments),
        patch.tipOverride ? JSON.stringify(patch.tipOverride) : null,
        patch.instructions ?? current.instructions,
        JSON.stringify(patch.notes ?? current.notes),
        now(),
        id,
      );
    return this.getBill(id)!;
  }

  /** Atomically mark the bill finalized and create its shares. */
  finalizeBill(id: string, shares: NewShare[]): ShareRecord[] {
    const ts = now();
    const insert = this.db.prepare(
      `INSERT INTO shares (id, bill_id, participant, is_host, amount_cents, currency, breakdown_json, status, updated_at)
       VALUES (@id, @billId, @participant, @isHost, @amountCents, @currency, @breakdown, @status, @ts)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(`UPDATE bills SET status = 'finalized', updated_at = ? WHERE id = ? AND status = 'draft'`)
        .run(ts, id).changes;
      if (changed !== 1) throw new Error('Bill is not in draft state');
      for (const share of shares) {
        insert.run({
          id: share.id,
          billId: share.billId,
          participant: share.participant,
          isHost: share.isHost ? 1 : 0,
          amountCents: share.amountCents,
          currency: share.currency,
          breakdown: JSON.stringify(share.breakdown),
          status: share.status,
          ts,
        });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.listShares(id);
  }

  listShares(billId: string): ShareRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM shares WHERE bill_id = ? ORDER BY is_host DESC, rowid ASC')
      .all(billId) as unknown as ShareRow[];
    return rows.map(toShare);
  }

  getShare(id: string): ShareRecord | null {
    const row = this.db.prepare('SELECT * FROM shares WHERE id = ?').get(id) as unknown as ShareRow | undefined;
    return row ? toShare(row) : null;
  }

  getShareByOrderId(orderId: string): ShareRecord | null {
    const row = this.db.prepare('SELECT * FROM shares WHERE paypal_order_id = ?').get(orderId) as unknown as ShareRow | undefined;
    return row ? toShare(row) : null;
  }

  updateSharePayment(id: string, update: SharePaymentUpdate): ShareRecord {
    const current = this.getShare(id);
    if (!current) throw new Error(`Share ${id} not found`);
    this.db
      .prepare(
        `UPDATE shares SET status = @status, paypal_order_id = @orderId, capture_id = @captureId,
           payer_name = @payerName, payer_email = @payerEmail, webhook_verified = @verified,
           paid_at = @paidAt, updated_at = @ts
         WHERE id = @id`,
      )
      .run({
        id,
        status: update.status,
        orderId: update.paypalOrderId ?? current.paypalOrderId,
        captureId: update.captureId !== undefined ? update.captureId : current.captureId,
        payerName: update.payerName !== undefined ? update.payerName : current.payerName,
        payerEmail: update.payerEmail !== undefined ? update.payerEmail : current.payerEmail,
        verified: (update.webhookVerified ?? current.webhookVerified) ? 1 : 0,
        paidAt: update.paidAt !== undefined ? update.paidAt : current.paidAt,
        ts: now(),
      });
    return this.getShare(id)!;
  }

  /**
   * Record a webhook event ID. Returns false if it was already seen, which
   * makes webhook processing idempotent against PayPal's at-least-once delivery.
   */
  recordWebhookEvent(id: string, eventType: string, resourceId: string | null): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id, received_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, eventType, resourceId, now());
    return result.changes === 1;
  }

  /** Remove a recorded event so PayPal's retry can be processed after a transient failure. */
  forgetWebhookEvent(id: string): void {
    this.db.prepare('DELETE FROM webhook_events WHERE id = ?').run(id);
  }
}
