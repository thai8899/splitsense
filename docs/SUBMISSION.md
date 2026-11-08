# SplitSense: hackathon submission kit

Deadline: **Thu Nov 12, 2026, 12:00 PM PT** (1:00 PM in Phoenix). Judging weights five criteria equally: Technological Implementation, Design, Potential Impact, Innovation, Presentation.

---

## 4.1 Three-minute demo video: script and storyboard

**Recording setup.** 1080p screen recording. Desktop browser on the left two-thirds, a phone (or 390 px mobile window) on the right for the friend's view. Use voiceover only, or royalty-free music you have rights to. The rules ban unlicensed music and third-party trademarks, so blur any real restaurant names and use the bundled fictional receipt. Keep the video **under 3:00**. Aim for 2:50.

**Before you hit record.** Deploy to Render. Register the webhook. Log into two sandbox personal accounts in two browser profiles. Open one finished bill in a tab as a fallback.

| Time | On screen | Voiceover |
|---|---|---|
| **0:00–0:08** | Close-up of a long restaurant receipt, then a group chat full of "what do I owe you?" | "You covered dinner for four. Now comes the worst part of the night." |
| **0:08–0:30** | Quick cuts: calculator app, someone squinting at the tax line, a wrong Venmo amount. Text overlay: *Splitting evenly is unfair. Splitting by item is a chore.* | "Splitting evenly isn't fair. Splitting by item means reading every line, dividing shared plates, working out tax and tip in proportion, then chasing four people for four different amounts. Most of us just round down and lose money. SplitSense fixes that with Google Gemini and PayPal." |
| **0:30–0:45** | SplitSense home. Click **Try the sample receipt**. Type your PayPal email in **Your PayPal email**. Show names: Femi, Ada, Tolu, Kemi. Show the sentence. | "I add my PayPal email so my friends pay me directly, add the receipt, list who was there, and describe it the way I'd text it: Ada and I split the wings, Tolu had two of the three beers, we all shared dessert, add 20% tip." |
| **0:45–1:00** | Click **Split the bill**. The four-step progress panel ticks: Read the receipt → Check the math → Match items to people → Work out exact shares. | "Gemini reads the receipt and then checks its own arithmetic. If the items don't add up to the subtotal, it gets told exactly what's wrong and reads the receipt again. Then a second agent turns my sentence into item assignments." |
| **1:00–1:15** | Review screen. The highlighter marks sweep across the receipt in each friend's color. Hover the multi-color dessert line. | "Every line is highlighted in the color of whoever had it. Shared plates show every color. And these totals come from code, not the model, so they add up to the cent." |
| **1:15–1:22** | Tap a chip to move the salad from Kemi to Ada. Totals change. Click **18%** tip. | "If anything's off, one tap fixes it." |
| **1:22–1:30** | Click **Create payment links**. Dashboard: $0 of $110.75 back, green **Live** dot. Click **Send request**, and the share sheet appears. | "Create payment links, and each friend gets a link for exactly what they owe." |
| **1:30–1:45** | Phone: Ada's page. "Your share is $49.36", her lines only, tax and tip shares. Tap the **PayPal** button. Log into the sandbox. The review page shows the item breakdown. **Pay**. | "Ada sees just her items. The PayPal checkout shows the same breakdown, chicken wings half share, her share of tip, so there's nothing to argue about. She pays with PayPal, though Venmo, Pay Later or card would work too." |
| **1:45–2:00** | Split screen: the phone shows "You're square with Femi." The desktop dashboard row flashes green, the bar jumps to $49.36, and the badge goes **Paid**, then **Paid, confirmed by PayPal**. | "On my side it updates instantly. First 'Paid' when the capture succeeds, then 'Confirmed by PayPal' when PayPal's signed webhook arrives." |
| **2:00–2:30** | Architecture diagram from `docs/ARCHITECTURE.md`, animated left to right. Then a code close-up: the validation-error feedback sent back to Gemini, then `PayPal-Request-Id: capture-{orderId}`, then `verify-webhook-signature`. | "Under the hood: Gemini vision with forced function calls and JSON schemas, wrapped in a validate, feedback, retry loop. The AI decides who had what. Deterministic largest-remainder math decides how much. PayPal Orders v2 carries a full item breakdown. Captures are idempotent with request IDs. Webhooks are signature-verified, deduplicated and checked against the expected amount. And if a friend closes the tab after approving, the approved-order webhook captures on the server. Forty-two automated tests cover it." |
| **2:30–2:50** | Quick cut: the host's sandbox PayPal Activity showing +$49.36 arriving. Then the dashboard fills to 100%: "Everyone's paid you back." Roadmap overlay: group tabs, PayPal Payouts to pay friends back, recurring roommate bills, merchant QR at the table. | "And the money lands straight in my PayPal, no middleman. Every shared meal, trip and grocery run creates this debt, and PayPal is already in every friend's pocket. Next comes running tabs across trips, settling with PayPal Payouts, and restaurants printing a SplitSense QR on the receipt so the table settles before they stand up." |
| **2:50–3:00** | Logo, repo URL, live demo URL. | "SplitSense. Split the bill, not the friendship." |

**Shot tips.** Zoom the browser to 125% so the receipt text reads on mobile viewers. Record the AI steps live. If latency runs long, trim the middle but keep one real tick of each step. Never fake the payment: judges score "shows the project working end to end".

---

## 4.2 Devpost form answers

### Elevator pitch (50 words max)
> You paid for dinner; now everyone owes you different amounts. Snap the receipt, say who had what in plain English, and SplitSense's Gemini agents read it, check the math, and split tax and tip to the cent. Each friend gets an itemized PayPal link. Watch payments land live.

*(48 words)*

### What it does
SplitSense turns one receipt photo and one sentence into exact, itemized PayPal payment requests. The person who paid uploads the receipt (photo or PDF), lists who was there, and describes who had what the way they'd text it: "Ada and I split the wings, Tolu had two of the three beers, we all shared dessert, add 20% tip." Gemini's vision model transcribes the receipt and verifies its own arithmetic. A second Gemini agent maps the sentence onto the line items, handling "I", "everyone", nicknames and uneven shares. Deterministic code then splits every item, plus tax, tip, fees and discounts, in proportion and to the cent, so the shares always add up exactly to the bill. The host reviews a receipt highlighted in each friend's color, can fix any line with a tap or re-split with new wording, then creates payment links. Each friend opens their link, sees only their items, and pays through PayPal Smart Payment Buttons (PayPal, Venmo, Pay Later or card), straight into the host's own PayPal account when the host adds their PayPal email. The PayPal checkout itself shows the item breakdown. The host's dashboard updates live as captures succeed and PayPal's signed webhooks confirm them.

### How we built it
- **Frontend:** React 19, Vite, TypeScript and Tailwind CSS 4. `@paypal/react-paypal-js` renders the Smart Payment Buttons. Progress streams in as NDJSON, and Server-Sent Events drive the live dashboard.
- **Backend:** Node.js 22, Express 5 and TypeScript, with zod validation on every input, environment variable and AI output. Node's built-in SQLite (`node:sqlite`) keeps setup at zero, with nothing to compile.
- **AI:** Google Gemini (`gemini-3.5-flash`) through the official `@google/genai` SDK, with Anthropic Claude supported as a drop-in alternative (`AI_PROVIDER`). Two forced function calls (`record_receipt` and `assign_items`) with JSON schemas, wrapped in a custom validate → feedback → retry loop. Validation failures go back to the model as function-response errors, so it corrects itself. Receipts can be images or PDFs.
- **PayPal:** Orders v2 `payee` sends each friend's payment straight to the host's PayPal account when they add their email. OAuth 2.0 client credentials with cached, early-refreshing, single-flight tokens. Orders v2 create (with `items[]`, `amount.breakdown`, `custom_id` and `experience_context`) and capture. `PayPal-Request-Id` makes requests idempotent. `verify-webhook-signature` checks events, and handlers cover `PAYMENT.CAPTURE.*` and `CHECKOUT.ORDER.APPROVED`. Everything runs in the PayPal Sandbox.
- **Hosting and quality:** Deployed on Render from a Blueprint. 42 Vitest and Supertest tests run fully offline using scripted AI clients (Gemini and Claude) and a PayPal fake.

### Challenges we ran into
- **LLMs and money don't mix, so we separated them.** If a model computes each person's total, rounding drifts and pennies go missing. So the AI only decides who had what, and integer cent math using the largest-remainder method decides how much. Totals reconcile exactly every time.
- **Receipts lie, and so do vision models.** Blurry digits and modifier lines can produce totals that don't reconcile. Instead of trusting the first answer, the agent checks items against the subtotal and components against the total, then sends the specific mismatch back ("line items sum to 128.00 but subtotal is 118.00") so Gemini re-reads the receipt.
- **PayPal breakdown validation.** Orders v2 rejects a purchase unit unless `item_total` equals the sum of the items and the amount equals the breakdown. Fractional shares ("1/3 of the pizza") and proportional tax had to map onto whole-cent items with tip as its own item, service fees as `handling`, and discounts as `discount`.
- **Webhook verification on valid events.** Re-serializing a parsed event can change its bytes and make a genuine event fail verification. We capture the raw body before JSON parsing and splice it into the verification payload unchanged.
- **Buyers who approve and close the tab.** We handle `CHECKOUT.ORDER.APPROVED` and capture on the server, using the same request ID as the browser's capture, so the two paths can't double-charge.

### Accomplishments that we're proud of
- A complete end-to-end flow on the PayPal Sandbox, from a photo to verified money with a live dashboard, built during the submission period.
- An AI agent that catches and fixes its own arithmetic mistakes before anyone is charged.
- Shares that sum to the bill to the cent, backed by tests across hundreds of rounding cases.
- PayPal's own checkout page shows the AI's split item by item, so it's transparent to the person paying.
- A design built around the receipt itself: highlighter marks in each friend's color, shared plates striped in every color.
- 42 tests, strict TypeScript, zero-config local setup and a one-click Render deploy.

### What we learned
- Agents are most reliable when the model's mistakes become its next input. Schema-forced tool calls plus specific validation feedback beat longer prompts.
- In fintech, give the model judgment and give the code arithmetic.
- PayPal's breakdown, `custom_id` and `PayPal-Request-Id` fields are what make an AI-generated order auditable and safe to retry.
- Webhooks are the source of truth. The browser's "success" is only a hint, and the signed `PAYMENT.CAPTURE.COMPLETED` is the confirmation.

### What's next for SplitSense
- **Running tabs** for trips and roommates, with settle-up that nets out who owes whom across many bills.
- **PayPal Payouts** so a group pot can pay one person back in a single action, and Venmo-first links for US friends.
- **Restaurant mode:** a QR code printed on the receipt so the table settles before leaving, with the merchant paid directly.
- **Recurring splits** for rent and utilities using PayPal subscriptions.
- **Multi-currency trips** with PayPal currency conversion, plus receipts in any language.
- Postgres and multi-instance SSE (Redis pub/sub) for horizontal scale.

### Built with
`google-gemini` `gemini-api` `anthropic-claude` `paypal` `paypal-checkout` `paypal-orders-v2` `paypal-webhooks` `venmo` `react` `typescript` `node.js` `express` `vite` `tailwindcss` `sqlite` `zod` `vitest` `render`

### Testing instructions for judges (paste into the "Testing access" field)
> **Live demo:** https://splitsense-t08n.onrender.com
> 1. Click **Try the sample receipt**, then **Split the bill**.
> 2. Review the split, then click **Create payment links**.
> 3. Click **Open** next to any friend, then the yellow **PayPal** button.
> 4. Log in with this PayPal **Sandbox** buyer: `<sandbox-buyer-email>` / `<sandbox-buyer-password>` (no real money).
> 5. Return to the dashboard tab and watch the share turn Paid, then "Confirmed by PayPal."
>
> Run locally: see the README (`npm install && cp .env.example .env && npm run dev`). Tests: `npm test`.

---

## Submission checklist
- [ ] Repo is public on GitHub, and **MIT** shows in the About sidebar (GitHub detects `LICENSE` automatically)
- [ ] Render deployed with `APP_BASE_URL`, PayPal and Anthropic keys; webhook registered and `PAYPAL_WEBHOOK_ID` set
- [ ] Ran the full flow on the hosted URL with a sandbox buyer and saw "Confirmed by PayPal"
- [ ] Video under 3:00, public on YouTube, no unlicensed music or third-party trademarks
- [ ] Devpost: pitch, description, built-with, repo URL, demo URL, video URL, sandbox buyer login
- [ ] Optional sponsor prize: select **Render** (the project is deployed with the Render Blueprint)
- [ ] Keep the Render service and API keys live through **Dec 15, 2026** (end of judging). Set a spend limit on the Anthropic key
