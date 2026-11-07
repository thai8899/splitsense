/**
 * Typed client for the SplitSense API. Shapes mirror server/src/bills.ts.
 */

export interface ReceiptItem {
  id: string;
  name: string;
  quantity: number;
  totalCents: number;
}

export interface Receipt {
  merchant: string;
  currency: string;
  date: string | null;
  items: ReceiptItem[];
  subtotalCents: number;
  taxCents: number;
  tipCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
}

export interface WeightedShare {
  participant: string;
  weight: number;
}

export interface ItemAssignment {
  itemId: string;
  shares: WeightedShare[];
  reason?: string;
}

export type TipOverride = { mode: 'percent'; value: number } | { mode: 'amount'; valueCents: number };

export interface PersonBreakdown {
  participant: string;
  items: Array<{ itemId: string; name: string; portion: string; amountCents: number }>;
  itemsCents: number;
  taxCents: number;
  tipCents: number;
  serviceFeeCents: number;
  discountCents: number;
  totalCents: number;
}

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

export interface ShareView {
  id: string;
  participant: string;
  amountCents: number;
  currency: string;
  status: ShareStatus;
  paid: boolean;
  webhookVerified: boolean;
  paidAt: string | null;
  payerName: string | null;
  breakdown: PersonBreakdown;
  payUrl: string;
}

export interface BillView {
  id: string;
  title: string;
  hostName: string;
  participants: string[];
  status: 'draft' | 'finalized';
  instructions: string;
  notes: string[];
  receipt: Receipt;
  assignments: ItemAssignment[];
  tipOverride: TipOverride | null;
  split: { currency: string; people: PersonBreakdown[]; unassignedItemIds: string[]; tipCents: number; grandTotalCents: number };
  shares: ShareView[];
  progress: { collectedCents: number; owedCents: number; paidCount: number; owedCount: number };
  createdAt: string;
}

export interface PublicShare {
  share: ShareView;
  bill: { title: string; hostName: string; merchant: string; date: string | null; partySize: number };
}

export interface AppConfig {
  paypalClientId: string;
  environment: 'sandbox' | 'live';
  aiModel: string;
  sampleReceiptAvailable: boolean;
}

export type ProcessStage = 'reading_receipt' | 'verifying_math' | 'assigning_items' | 'computing_shares';

export type ProcessEvent =
  | { type: 'progress'; stage: ProcessStage; message: string }
  | { type: 'result'; billId: string; adminToken: string; bill: BillView }
  | { type: 'error'; error: string };

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (token) headers.set('x-admin-token', token);
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`, response.status, body);
  }
  return body as T;
}

export const api = {
  config: () => call<AppConfig>('/api/config'),

  /**
   * Upload the receipt and stream the AI's progress. The server answers with
   * newline-delimited JSON: progress events, then one result or error.
   */
  async process(form: FormData, onEvent: (event: ProcessEvent) => void): Promise<void> {
    const response = await fetch('/api/ai/process', { method: 'POST', body: form });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(body.error ?? `Upload failed (${response.status})`, response.status, body);
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onEvent(JSON.parse(line) as ProcessEvent);
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer) as ProcessEvent);
  },

  bill: (id: string, token: string) => call<BillView>(`/api/bills/${id}`, {}, token),

  reallocate: (id: string, token: string, instructions: string) =>
    call<BillView>(`/api/bills/${id}/allocate`, { method: 'POST', body: JSON.stringify({ instructions }) }, token),

  saveAssignments: (
    id: string,
    token: string,
    assignments: ItemAssignment[],
    tip: { mode: 'receipt' } | { mode: 'percent'; value: number } | { mode: 'amount'; value: number },
  ) => call<BillView>(`/api/bills/${id}/assignments`, { method: 'PUT', body: JSON.stringify({ assignments, tip }) }, token),

  finalize: (id: string, token: string) => call<BillView>(`/api/bills/${id}/finalize`, { method: 'POST' }, token),

  share: (id: string) => call<PublicShare>(`/api/shares/${id}`),

  createOrder: (shareId: string) =>
    call<{ id: string; status: string }>('/api/payments/create-order', { method: 'POST', body: JSON.stringify({ shareId }) }),

  captureOrder: (shareId: string, orderId: string) =>
    call<{ status: 'COMPLETED' | 'PENDING'; captureId: string | null; share: ShareView }>('/api/payments/capture-order', {
      method: 'POST',
      body: JSON.stringify({ shareId, orderId }),
    }),
};

/** Remember the host token per bill so refreshing the page keeps access. */
export const tokens = {
  get(billId: string): string | null {
    try {
      return localStorage.getItem(`splitsense:token:${billId}`);
    } catch {
      return null;
    }
  },
  set(billId: string, token: string): void {
    try {
      localStorage.setItem(`splitsense:token:${billId}`, token);
    } catch {
      /* storage unavailable (private mode); the URL still carries the token */
    }
  },
};
