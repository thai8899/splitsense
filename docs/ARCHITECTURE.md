# SplitSense architecture

## 1.1 Executive summary

**Target audience.** Anyone who pays the whole bill for a group and has to collect from friends afterward. That includes friends at dinner, roommates after a grocery run, coworkers on a team lunch, students splitting takeout, and organizers of group trips.

**Core problem.** Splitting evenly is unfair. Splitting by item is tedious: someone has to read the receipt line by line, work out shared plates, divide tax and tip in proportion, round to the cent, then send each friend a request. In practice the payer rounds down, eats the difference, or never collects. The work is mostly arithmetic plus a little social awkwardness, and those are the parts that make people give up.

**Solution.** SplitSense turns a receipt photo and one plain-English sentence into exact PayPal payment requests:

1. **Claude vision** reads the receipt into structured line items. It **checks its own arithmetic** (do the items add up to the subtotal, and do the components add up to the total?). If the numbers don't reconcile, the mismatch is sent back to the model so it can read the receipt again.
2. **A Claude allocation agent** turns "Ada and I split the wings, Tolu had 2 of the 3 beers, add 20% tip" into weighted assignments for each item. Unknown names, made-up items and skipped items are rejected with precise feedback, and the agent retries.
3. **Deterministic code**, not the model, computes every cent. It uses the largest-remainder method, so everyone's shares always add up exactly to the bill.
4. **PayPal Orders v2** charges each friend for exactly their share. The order carries a full item breakdown, so the PayPal review page shows "Grilled Salmon, Chicken Wings (1/2 share), your share of tax and tip".
5. **Verified PayPal webhooks** confirm each capture and update the host's dashboard live over Server-Sent Events.

**Why PayPal is indispensable.** Every workflow in the product ends with money moving between friends. Without PayPal, SplitSense is a calculator that leaves the hard part (collecting) unsolved. PayPal provides:

- A checkout every friend already trusts, with PayPal balance, Venmo, Pay Later and cards all behind one button.
- Itemized orders (`items[]` and `amount.breakdown`), so the AI's split is visible and auditable on PayPal's own review page.
- Webhooks signed by PayPal, so "paid" means PayPal confirmed it, not that a browser said so.
- Idempotent capture with `PayPal-Request-Id`, which makes double-clicks and retries safe.

## 1.2 Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React 19, Vite 8, TypeScript, Tailwind CSS 4, React Router 7 | Fast single-page app with a small bundle (~97 kB gzip) |
| Payment UI | `@paypal/react-paypal-js` (PayPal JS SDK, Smart Payment Buttons) | Official SDK. Shows PayPal, Venmo, Pay Later and card |
| Backend | Node.js 22, Express 5, TypeScript (ESM) | Typed end to end. Express 5 forwards async errors natively |
| Validation | zod 4 | Every request body, every environment variable, and every AI tool output |
| Database | SQLite via Node's built-in `node:sqlite` (WAL mode) | No native build and no server, on any OS. Transactional finalize. Swap-ready repository layer |
| PayPal APIs | OAuth 2.0 client credentials, Orders v2 (create, capture, get), Webhooks verify-signature | See below |
| AI | Anthropic Claude (`claude-sonnet-5-5`) via `@anthropic-ai/sdk` | Vision plus PDF input, forced tool use with a JSON schema |
| Agent framework | Custom validate → feedback → retry loop (no LangChain) | Small, testable, and the model's errors become its own input |
| Realtime | Server-Sent Events | One-way push of status changes. No extra infrastructure |
| Hosting | Render (Blueprint in `render.yaml`) | One service serves the API and static build. Health check at `/api/health` |
| Tests | Vitest + Supertest (34 tests) | Money math, PayPal client, agent loop, full API flow with fakes |

### PayPal integration details

| Purpose | Endpoint | Notes |
|---|---|---|
| Auth | `POST /v1/oauth2/token` | Basic auth with client ID and secret. Token cached in memory and refreshed 60 s before expiry. Concurrent callers share one in-flight request. A 401 triggers one refresh and retry |
| Create order | `POST /v2/checkout/orders` | `intent: CAPTURE`. `custom_id`/`reference_id` = share ID. `items[]` + `breakdown` (item_total, tax_total, handling, discount). `experience_context` with `NO_SHIPPING` and `PAY_NOW`. `PayPal-Request-Id` set |
| Capture | `POST /v2/checkout/orders/{id}/capture` | `PayPal-Request-Id: capture-{orderId}`, so retries are idempotent. `ORDER_ALREADY_CAPTURED` is treated as success. `INSTRUMENT_DECLINED` → button `actions.restart()` |
| Get order | `GET /v2/checkout/orders/{id}` | Used for already-captured recovery |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` | The raw request body is spliced in byte for byte. Re-serializing it can break verification |
| Webhook events | `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DENIED`, `.DECLINED`, `.REFUNDED`, `.REVERSED`, `CHECKOUT.ORDER.APPROVED` | Deduplicated by event ID. Amount and currency checked against the stored share. On `CHECKOUT.ORDER.APPROVED` the server captures, which covers buyers who close the tab |

## Data flow

```
 ┌──────────────────────────── Browser (React) ────────────────────────────┐
 │  NewBill            Review (draft)          Dashboard          PayShare  │
 │  photo + names      highlighted receipt     live progress      friend's  │
 │  + "who had what"   tap-to-fix chips        (EventSource)      PayPal    │
 └─────┬──────────────────────┬───────────────────────▲──────────────┬──────┘
       │ multipart            │ JSON                  │ SSE          │ PayPal JS SDK
       │ POST /api/ai/process │ PUT/POST /api/bills/* │              │ createOrder / onApprove
       ▼ (NDJSON progress)    ▼                       │              ▼
 ┌──────────────────────────── Express API (Node 22) ───────────────────────┐
 │                                                                          │
 │  ┌──────────── AI Engine (ai_agent.ts) ────────────┐                     │
 │  │ 1 extractReceipt: image/PDF ─► Claude vision    │   ┌──────────────┐  │
 │  │   tool=record_receipt ─► zod ─► arithmetic check│   │  money.ts    │  │
 │  │   mismatch? ─► tool_result(is_error) ─► retry   │──►│ largest-     │  │
 │  │ 2 allocate: sentence ─► Claude                  │   │ remainder    │  │
 │  │   tool=assign_items ─► names/items check ─► retry│  │ split, cents │  │
 │  └─────────────────────────────────────────────────┘   └──────┬───────┘  │
 │                                                               ▼          │
 │   bills.ts ── shares + PayPal order input ──► SQLite (bills, shares,     │
 │                                                webhook_events)           │
 │   POST /api/payments/create-order ─┐                ▲                    │
 │   POST /api/payments/capture-order ┤                │ status updates     │
 │   POST /api/webhooks/paypal ◄──────┼────────────┐   │ ──► EventHub (SSE) │
 └────────────────────────────────────┼────────────┼───┴────────────────────┘
                                      ▼            │
 ┌────────────────────── PayPal Sandbox (api-m.sandbox.paypal.com) ─────────┐
 │  /v1/oauth2/token   /v2/checkout/orders   /v2/checkout/orders/{id}/capture│
 │  /v1/notifications/verify-webhook-signature  ◄── server verifies          │
 │  Webhooks: PAYMENT.CAPTURE.COMPLETED, CHECKOUT.ORDER.APPROVED ───────────┘
 └──────────────────────────────────────────────────────────────────────────┘
```

### Request lifecycle, end to end

1. **Upload.** The browser shrinks the photo to 2000 px JPEG (which also converts Safari HEIC) and posts it with the names and the description.
2. **Sniff.** The server identifies the file from its magic bytes (JPEG, PNG, GIF, WebP or PDF) and ignores the client's MIME type.
3. **Stream.** The response becomes `application/x-ndjson`. Each agent stage (`reading_receipt`, `verifying_math`, `assigning_items`, `computing_shares`) is written as a line, and the UI checks off a stepper as they arrive.
4. **Extract.** `record_receipt` is a forced tool call. The output passes zod validation, gets converted to cents without float drift, and is reconciled. If it fails, the model gets: "line items sum to 128.00 but subtotal is 118.00. Look at the receipt again…"
5. **Allocate.** `assign_items` is a forced tool call. Names are canonicalized ("femi" → "Femi"). Unknown names, duplicate or missing items are rejected with feedback. Tip requests become a `TipOverride`.
6. **Compute.** `computeSplit` divides each item by weight, then spreads tax, tip, fees and discount in proportion to each person's item subtotal. The sum of the shares is guaranteed to equal the grand total.
7. **Review.** The host sees the receipt with highlighter marks in each friend's color, can tap chips to fix lines, change the tip, or re-run the AI with new wording.
8. **Finalize.** In one SQLite transaction the bill becomes `finalized` and one share is created per person. The host's own share is marked `host`.
9. **Pay.** The friend's link opens `/pay/:shareId`. `createOrder` → server prices the order **from the database** (the browser never sends an amount) → PayPal popup → `onApprove` → server captures, checks the captured amount and currency, and marks the share `captured`.
10. **Confirm.** PayPal sends `PAYMENT.CAPTURE.COMPLETED`. The server verifies the signature, deduplicates the event, re-checks the amount, and marks the share `completed`. EventHub pushes the change to the host, whose progress bar moves while they watch.

## Data model

```
bills(id, admin_token_hash, title, host_name, participants_json, receipt_json,
      assignments_json, tip_override_json, instructions, notes_json, status, created_at, updated_at)
shares(id, bill_id → bills, participant, is_host, amount_cents, currency, breakdown_json,
       status, paypal_order_id UNIQUE, capture_id, payer_name, payer_email,
       webhook_verified, paid_at, updated_at)
webhook_events(id PK, event_type, resource_id, received_at)     -- idempotency ledger
```

Share states: `host → (none)`, `awaiting → order_created → approved → captured → completed`. Side branches are `pending` (PayPal review), `failed` (declined) and `refunded`.

## Security and correctness decisions

- **The AI never sets a charge amount.** It reads numbers and decides who had what. Code computes cents. Every order is priced server-side from stored data.
- **Host links are capabilities.** The admin token is 24 random bytes. Only its HMAC-SHA256 (keyed with `APP_SECRET`) is stored, and comparison is constant-time. Payment links use 16-byte random IDs.
- **Webhooks are verified, deduplicated and amount-checked.** An unverified event gets a 400. A processing failure removes the event from the ledger so PayPal's retry is handled.
- **Idempotency everywhere.** `PayPal-Request-Id` on create and capture, a unique index on `paypal_order_id`, and finalize allowed only from `draft`.
- **Prompt-injection hygiene.** Receipt text and the host's description are framed as data in the system prompts. Tool outputs are schema-validated, never executed.
- **Input limits.** 8 MB upload cap, magic-byte sniffing, 12-person maximum, rate limit on the AI endpoints (10 requests per minute per IP).
- **Fail fast on config.** Every environment variable is validated at boot. The webhook verification bypass is refused in production.
