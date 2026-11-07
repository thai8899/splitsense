/**
 * Server-Sent Events hub: pushes share status changes to the host's dashboard
 * the moment a capture or webhook lands, with no polling.
 */
import type { Response } from 'express';

export interface BillEvent {
  type: 'share_updated' | 'bill_updated';
  billId: string;
  shareId?: string;
  status?: string;
  at: string;
}

export class EventHub {
  private readonly subscribers = new Map<string, Set<Response>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(heartbeatMs = 25_000) {
    // Comments keep proxies (Render, nginx) from closing idle connections.
    this.heartbeat = setInterval(() => {
      for (const set of this.subscribers.values()) for (const res of set) res.write(': ping\n\n');
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  subscribe(billId: string, res: Response): () => void {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const set = this.subscribers.get(billId) ?? new Set<Response>();
    set.add(res);
    this.subscribers.set(billId, set);
    return () => {
      set.delete(res);
      if (set.size === 0) this.subscribers.delete(billId);
    };
  }

  publish(event: Omit<BillEvent, 'at'>): void {
    const payload: BillEvent = { ...event, at: new Date().toISOString() };
    const set = this.subscribers.get(event.billId);
    if (!set) return;
    const frame = `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(frame);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const set of this.subscribers.values()) for (const res of set) res.end();
    this.subscribers.clear();
  }
}
