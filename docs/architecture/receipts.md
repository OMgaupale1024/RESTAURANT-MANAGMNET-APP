# Receipts

The reference for how OraOS turns an order into a receipt — the paper a customer
takes home, the message they get on WhatsApp, and the on-screen view staff show
at the counter. Read this before touching anything that renders, prints, or
shares a bill.

## The one rule

There is **one receipt template**, `BillReceipt` (`apps/web/src/lib/receipt.tsx`).
Every surface renders that same component:

- **Print** (80mm thermal and A4) — via `usePrintArea` + `window.print()`.
- **On screen** (the `ReceiptView` modal) — the same component as a paper card.
- **WhatsApp** — a plain-text projection of the same order via `buildShareText`.

Never write a second receipt. If a surface needs the bill to look different,
that is a style concern on the one template, not a new template. Duplicated
receipt logic is how a printed total comes to disagree with a shared one.

## What a receipt shows

From the order's own stored snapshots and the saved restaurant profile — never
invented, never fetched twice:

- **Branding**: `receiptHeader` (or name), address, phone, GSTIN, FSSAI — each
  omitted if the profile lacks it.
- **Bill # / date / type**, **items** (with per-line notes), **subtotal**,
  **discount**, **CGST/SGST** grouped by rate, **grand total**, **payment
  method(s)**.
- **Customer** (name · phone) when the order has one; absent for a walk-in.
- **Loyalty** (below) when available.
- **Thank-you**: the profile's `receiptFooter`, or a warm default so every
  receipt closes kindly. Plus `Order #`.

Deliberately **not** shown, because the data does not exist yet — shown the day
it does, never faked:

- **Cashier** — orders carry no `createdByUserId`. Adding it is an orders-model
  change (a prior milestone); until then the line is omitted.
- **"Points earned on this order"** — earning is not yet wired into checkout
  (that is Smart Checkout). The receipt shows the *balance* and *lifetime
  earned*, which are real, not a per-order figure that would be a guess.
- **QR code** — no QR infrastructure exists (and the strict CSP forbids a CDN
  library). Added when there is a real thing to encode (a receipt link), not as
  an empty placeholder.

## Loyalty integration

The receipt's engagement hook. `BillReceipt` takes an **optional** `loyalty`
prop (`LoyaltySummary`, Milestone 2). When present it renders a compact,
**text-only** block: tier, points balance, lifetime earned, and either the gap
to the next tier or a top-tier thank-you. Text-only is deliberate — it prints
identically on an 80mm thermal head and on A4, where a graphical bar or QR
would not.

The data is **derived, never fabricated**:

- Fetched lazily, **once**, when the receipt opens, via `getLoyaltySummary`
  (needs `loyalty.read`).
- A guest order, a viewer without `loyalty.read`, or any fetch failure ⇒ the
  prop is `null` ⇒ the block is **omitted**. There is no half-populated or
  guessed loyalty state.
- The result is cached and guarded by `customerId`, so a different order in the
  same sheet never shows the previous customer's points.

The same optional loyalty flows into `buildShareText`, adding one line to the
WhatsApp message (`⭐ Gold · 1,240 points · 13,600 to Platinum`).

## Print flow

`usePrintArea` renders the receipt into a hidden `#print-area` portalled to
`<body>`, then calls `window.print()`. Print CSS (`globals.css`) hides the app
and shows only that node; `@page { margin: 4mm }`. The `.rc` template is sized
to 72mm (thermal printable width) and is harmless on A4. No popup, no iframe —
nothing for a popup blocker or the CSP to catch. `afterprint` clears the node.

`ReceiptView` and the KOT button each own an independent `usePrintArea`; only
the one actively printing renders a `#print-area`, so the two never collide.

## Share flow

`buildShareText(order, profile, loyalty?)` builds a plain-text bill;
`waShareUrl(text, phone?)` wraps it in a `https://wa.me/<number>?text=…` link,
targeting the customer's number when the order has one. Opened with
`noopener,noreferrer`. WhatsApp only carries text, so the shared receipt is
text — the same figures as the printed one, by construction (same order, same
helpers).

## On-screen view

`ReceiptView` is a `Modal` (native `<dialog>` — focus trap, Esc, inert
background for free) containing the `BillReceipt` as a white paper card on a
themed backdrop (a receipt looks like paper even in dark mode), with **Print**
and **WhatsApp** actions. The 72mm card fits any phone and scrolls inside the
dialog — the "clean mobile-friendly receipt." Opened from the order detail's
**Receipt** button; it replaced the separate Print-bill and Share buttons,
folding both into one unified surface.

## Reuse map

| Need | Reused, not rebuilt |
| --- | --- |
| Receipt template | `BillReceipt` (extended with optional `loyalty`) |
| Print | `usePrintArea` + existing print CSS |
| Share text / link | `buildShareText` / `waShareUrl` (extended with optional `loyalty`) |
| Modal | `components/ui/modal` (`Modal`) |
| Loyalty data | Milestone 2's `GET /customers/:id/loyalty` |
| Money / points formatting | `formatMinor` / `toLocaleString('en-IN')` |

Net new code is small: an optional prop and a text block on the template, one
`ReceiptView` wrapper, one API client function, a little CSS.

## Security

The receipt shows only what the order already exposes to a viewer who can see
it (RLS + `order.read`), plus loyalty behind `loyalty.read` — fetched
best-effort and omitted on refusal, so a kitchen viewer without the permission
simply sees a receipt with no loyalty block. No customer data is exposed that
was not already authorized. Tenant isolation and RBAC are the M2 loyalty
endpoint's, unchanged.

## Future

- **Cashier line** once orders record who created them.
- **Points earned on this order** once Smart Checkout wires earning into
  payment — a one-line addition to the loyalty block.
- **QR code / receipt link** — a public, tokenized receipt URL would let a
  customer keep the receipt without WhatsApp; it needs a public route and a
  signed token (new infrastructure and a new security surface), so it is its own
  milestone. When it exists, the QR encodes that link and slots into the
  template's footer.
- **A graphical tier-progress bar** on the *screen* view (kept off the print
  path, which stays text-only).
