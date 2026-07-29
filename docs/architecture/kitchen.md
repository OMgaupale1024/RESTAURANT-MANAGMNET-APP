# Kitchen OS

The reference for the Kitchen Display System (KDS) — the screen a line runs its
whole shift from. Read this before changing anything on the kitchen board, the
order state machine, or the realtime feed.

## What it is

A **kanban board over the order state machine**, one column per active stage,
live over the existing per-tenant socket. It is always dark (a wall screen /
tablet in a hot kitchen, DESIGN.md §6) and is built for speed, glanceability,
and touch. The board holds one list of orders in React state; socket events
**patch that list** — a status change rewrites one ticket in place, and only
that ticket re-renders. The screen never reloads and never polls.

`apps/web/src/app/dashboard/kitchen/kitchen-client.tsx` is the board;
`lib/socket.ts` the connection; `lib/kitchen-sound.ts` the chime; the columns
and cards reuse `orders/order-detail.tsx` (status meta, the detail sheet).

## Workflow & state machine

The kitchen vocabulary maps onto the order lifecycle:

```
NEW ──Start──▶ PREPARING ──Ready──▶ READY ──Deliver──▶ DELIVERED
 (PLACED)                                                (COMPLETED)
   └───────────────── Cancel / Void ─────────────────▶ CANCELLED / VOIDED
```

The line cook's verbs (**Start · Ready · Deliver**) relabel the same
transitions the admin Orders screen calls Start/Ready/Complete; the underlying
target states are `PLACED → PREPARING → READY → COMPLETED`. Only relabelled,
never a different flow.

The machine is a **server-enforced whitelist** (`apps/api/src/modules/orders/order-status.ts`),
mirrored on the client only to decide which button to show:

| from | allowed |
| --- | --- |
| PLACED | PREPARING · CANCELLED · VOIDED |
| PREPARING | READY · CANCELLED · VOIDED |
| READY | COMPLETED · CANCELLED · VOIDED |
| COMPLETED / CANCELLED / VOIDED | — (terminal) |

**No hidden transitions.** Anything not listed is refused with a 409 — the
interesting attacks are the skips (PLACED → COMPLETED without paying,
CANCELLED → COMPLETED to resurrect a refund). Terminal states are dead ends: a
completed/cancelled/voided order is a financial record, corrected by a new row
(a refund), never by moving it back. **CANCELLED vs VOIDED** is a money
distinction — VOID reverses a rung-up sale and needs `order.void` (which a
cashier lacks); both restock ingredients (REVERSING_STATUSES).

The client never trusts its mirror: it offers a button, the server decides.

## Realtime architecture

One authenticated Socket.IO connection per client, opened with the access token
in the handshake `auth` payload (never a query string — that lands in logs and
proxies). The gateway (`realtime.gateway.ts`) is the security spine and is left
untouched by this milestone:

- **Separate connection, separate authorization.** HTTP guards do not cover a
  socket, so the gateway verifies the JWT itself on connect and joins the
  client to **exactly one room — its own tenant's**, taken from the verified
  token, never from anything the client sends. A client cannot choose a room; a
  global broadcast would leak one restaurant's live feed to every other.
- **Revocation aware.** A "sign out everywhere" or a deactivation drops the live
  sockets — otherwise the feed would outlive the session for as long as the tab
  stayed open.
- **Emit after commit.** Services call `emitToTenant` only after their
  transaction commits, so the board never hears about an order that rolled back.

On the board:

- `order.created` → fetch that one order and insert it (with the new-ticket
  **chime** and a slide-in + flash entrance).
- `order.status_changed` → rewrite that one row's status in place; if it's off
  the board but now needs cooking, pull it in.
- **connect / reconnect** → resync the whole active list, covering any events
  missed while disconnected.

No polling, one subscription (closed on unmount), one source of order state.

## The order card

Readable from several feet, one tap to act. Each ticket shows, from the order's
own data (no extra fetch):

- **Order number** (large, mono) · **order type** (always shown — Dine-in and
  Delivery stand out in colour, Takeaway stays quiet as the counter default) ·
  **elapsed timer**.
- **Payment status** — an **Unpaid** flag, *only when relevant*: a pay-later
  ticket the counter must still collect on. Fully-paid orders (the POS default)
  stay unmarked, so the card carries no money noise.
- **Customer name** (when attached — name only, no phone/PII on the wall).
- **Items · quantities · special instructions** (per-line notes and the order
  note, the order note highlighted).
- **Current status** is the column; the detail sheet shows the badge.

The one primary **action button** is full-width and large (`size="lg"`) — the
stage's next step (Start / Ready / Deliver). Cancel and Void live in the ticket
detail behind a typed-reason confirm, because reversing an order is deliberate,
not a fast-repeated tap.

## Timers

Each ticket self-ticks an elapsed chip — the **only** thing on the board that
re-renders every second (it is isolated in its own `<Elapsed>`, so the ticket
and its clock never re-render each other). Three states escalate the tone:

- **Normal** → **Warning** at 10 min → **Critical** at 20 min, the last with a
  slow opacity pulse (never a flash; reduced-motion collapses it).

The thresholds are **sensible defaults, not restaurant-specific values baked in
scattered** — they are two named constants (`WARN_MS`, `CRIT_MS`) that a future
per-tenant kitchen-settings row would feed. There is no such settings table
today, so the defaults stand, configurable later without touching the board.

## Touch & performance

Built for tablets and large displays: large tap targets, independent
per-column scroll (minimal whole-page scrolling), and fast repeated actions.
Every advance is **optimistic** — the ticket moves the instant you tap, the
socket echo lands on the same status, and a failure rolls back only that
ticket. A **synchronous in-flight guard** stops a double-tap from firing a
duplicate transition before the button disables. Tickets are `memo`-ised, so a
socket event re-renders exactly the ticket it changed; a state cap bounds a
board left open for days.

## Alerts

Audio is a **synthesised** two-tone chime (Web Audio, no file — nothing for the
CSP to block, nothing to ship), primed on the first touch (browsers block audio
without a gesture) and toggleable (persisted; default on — a kitchen wants to
hear orders). Visual alerts are the entrance flash on arrival and the timer tone
escalation. This is deliberately **not** a notification framework — just the
lightweight indicators a kitchen needs.

## Security

- Tenant isolation is the socket room (verified token) and RLS on every fetch.
- The KDS needs `order.read` (to see) and `order.update` (to advance) — both
  held by the KITCHEN role; Void additionally needs `order.void`, which it does
  not have.
- Only the customer's **name** reaches the wall — never phone, birthday, or
  loyalty. The board asks for order summaries, which carry no sensitive PII.

## Future integrations (not built)

- **Per-tenant timer thresholds** — a kitchen-settings row feeding `WARN_MS` /
  `CRIT_MS`; the board already reads them from one place.
- **Item-level bump** — checking off individual items as cooked (needs
  item-level state the order model does not track yet).
- **All-day view** — a running total per item across the board ("12 momos to
  cook"), aggregated from the same order list.
- **Recall / un-bump** — the state machine is forward-only by design; a recall
  would be a new, audited transition, not a silent move back.
- **Front-of-house "ready" alert** — notifying the counter when a ticket is
  plated; belongs to the Notifications milestone, not a bespoke channel here.
