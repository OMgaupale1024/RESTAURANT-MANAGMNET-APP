# OraOS — Design System & UI Plan (v1)

Status: proposed, awaiting approval. Scope: **UI/UX only** — no backend, API,
auth, RLS, or business-logic changes. This document is the redesign that
ROADMAP working rule 5 deferred ("minimal functional UI only; redesign comes
later"). Once approved, it supersedes that rule for visual work; every other
working rule still applies.

Rule: design must fit the existing backend (ROADMAP §"What exists now"). No
screen may imply a capability the API does not have.

---

## 1. Design philosophy

**The POS is the sensor; the dashboard is the lens.** (BLUEPRINT §1.) The UI's
job is to make correct data feel effortless to capture and obvious to read.

1. **Monochrome chrome, colored data.** The interface is near-monochrome —
   ink on quiet surfaces, hairline borders. Color is reserved for three jobs:
   the brand accent (yellow, sparingly), chart series (validated palette, §4),
   and status (fixed semantic scale). When everything is gray, the one colored
   thing is the message. This is the Linear/Stripe move.
2. **Density where work happens, air where thinking happens.** POS and KDS are
   dense, large-target, glanceable tools. Dashboard, Analytics, AI are calm,
   spacious reading surfaces. Same tokens, two densities.
3. **Numbers are the product.** Money and counts always `tabular-nums`, always
   right-aligned in columns, never truncated. A restaurant owner's trust is
   won by the numbers looking exact.
4. **Motion explains, never decorates.** Every animation answers "where did
   this come from / what changed?" — a new KDS ticket slides in from the edge
   it logically arrives from; a counter rolls because the value changed.
   Nothing loops, nothing bounces for fun. `prefers-reduced-motion` collapses
   everything to opacity or instant.
5. **Honest empty and loading states.** Cold-start restaurants see "no data
   yet, here's how to get some" — never fabricated numbers (same principle as
   the AI no-fabrication rule). Loading is skeletons shaped like the real
   content, never spinners on full pages.
6. **Desktop-first, tablet-critical.** Owners live on laptops; POS and KDS
   live on tablets. Phones get a competent responsive fallback, not a
   parallel design.

Avoid list (hard): Bootstrap-admin look, colored card headers, gradient stat
tiles, icon-in-colored-circle KPI cards, drop-shadow-heavy cards, rainbow
charts, glassmorphism.

---

## 2. Color system

All tokens live in `globals.css` via Tailwind 4 `@theme` — no config file, no
new dependency. Light/dark switch stays `prefers-color-scheme` (no toggle in
v1; a toggle is a later, isolated addition).

### Surfaces & ink

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-page` | `#fafaf9` | `#0a0a0a` | app background |
| `--color-surface` | `#ffffff` | `#161615` | cards, panels, inputs |
| `--color-surface-2` | `#f5f5f4` | `#1f1f1e` | hover washes, wells, code/kbd |
| `--color-ink` | `#171717` | `#ededed` | primary text |
| `--color-ink-2` | `60% ink` | `62% ink` | secondary text |
| `--color-ink-3` | `45% ink` | `45% ink` | labels, placeholders, axis text |
| `--color-line` | `rgb(0 0 0 / 0.08)` | `rgb(255 255 255 / 0.10)` | hairline borders |
| `--color-line-2` | `rgb(0 0 0 / 0.14)` | `rgb(255 255 255 / 0.16)` | input borders, emphasis lines |

### Brand

`--color-brand: #facc15` (yellow), `--color-brand-ink: #171717` — unchanged
from today. Yellow is **background/accent only, never text** (existing
contrast rule stands). Where yellow appears: primary buttons, the active-range
segment thumb, focus accents on the marketing/landing surface, selected POS
quantity badges. It should be visible on roughly *one* element per screen.

### Status (fixed, never themed, never used for chart series)

| Role | Fill (both modes) | Text light | Text dark | Use |
|---|---|---|---|---|
| success | `#0ca30c` | `#006300` | `#0ca30c` | paid, completed, in-stock, clock-in |
| warning | `#fab219` | `#8a5a00` | `#fab219` | low stock, pending, LOW confidence |
| danger | `#d03b3b` | `#b91c1c` | `#e66767` | void, failed, negative stock, clock-out overdue |
| info | `#2a78d6` | `#1c5cab` | `#3987e5` | neutral notices, DETERMINISTIC badge |

Status is always **icon + label + color**, never color alone (KDS floor
lighting, colorblind cashiers).

### Chart palette (validated 2026-07-18, dataviz method)

Categorical series, fixed assignment order, never cycled. Validated with the
dataviz six-check validator against our real surfaces — light `#ffffff`, dark
`#161615`: all hard gates pass in both modes (worst adjacent CVD ΔE 9.1
light / 8.4 dark; normal-vision floor 19.6 / 19.3). Light mode slots 3/4/5 sit
below 3:1 contrast → **relief rule: every chart direct-labels its values**
(we do this anyway, §5).

| Slot | Light | Dark |
|---|---|---|
| 1 blue | `#2a78d6` | `#3987e5` |
| 2 green | `#008300` | `#008300` |
| 3 magenta | `#e87ba4` | `#d55181` |
| 4 yellow | `#eda100` | `#c98500` |
| 5 aqua | `#1baf7a` | `#199e70` |
| 6 orange | `#eb6834` | `#d95926` |
| 7 violet | `#4a3aa7` | `#9085e9` |
| 8 red | `#e34948` | `#e66767` |

Sequential (magnitude — peak-hours intensity): one hue, blue steps
`#cde2fb → #0d366b` (light→dark; anchor flips in dark mode). Chart chrome:
gridlines `--color-line`, axis text `--color-ink-3`, 12px.

Rules carried from the method: one axis, never dual-axis; single series gets
slot 1 and **no legend** (the title names it); ≥2 series always get a legend;
color follows the entity, not its rank; status colors never impersonate a
series.

---

## 3. Typography & spacing

**Typefaces:** Geist Sans (already loaded) for everything; Geist Mono for
coupon codes, invite tokens, order IDs, and kbd hints. No display face — the
premium feel comes from weight/tracking discipline, not a second font.

| Style | Spec | Use |
|---|---|---|
| `display` | 28px / 1.2 / semibold / tracking -0.02em | hero number on stat cards |
| `title` | 20px / 1.3 / semibold / tracking -0.01em | page titles |
| `heading` | 15px / 1.4 / semibold | card and section headings |
| `body` | 14px / 1.5 / regular | default UI text |
| `small` | 13px / 1.4 | table cells, secondary rows |
| `label` | 12px / 1.3 / medium / uppercase tracking +0.04em / ink-3 | stat labels, column headers, nav groups |
| `micro` | 11px | badges, axis ticks |

All numeric UI (money, counts, quantities, table number columns):
`font-variant-numeric: tabular-nums`. Money renders via existing
`lib/money.ts` — display concerns never touch minor-unit math.

**Spacing:** 4px grid. Page padding 32px (desktop) / 16px (mobile). Card
padding 20px; dense card (POS tiles, KDS) 12px. Gap between cards 16px;
between page sections 32px. Max content width 1200px, left-aligned within the
main pane (not centered — sidebar apps read left-anchored). Vertical rhythm:
page title block 24px below top, first content 24px below title.

**Radius & elevation:** inputs/buttons 8px, cards 12px, modals/sheets 16px,
badges/pills full. Elevation is mostly *borders, not shadows*: cards =
surface + hairline border + `0 1px 2px rgb(0 0 0 / 0.04)`; popovers/menus =
`0 4px 16px rgb(0 0 0 / 0.08)`; modals = `0 16px 48px rgb(0 0 0 / 0.16)`.
Dark mode drops shadows and leans on surface steps + borders.

---

## 4. Component library

All components are project-local (`src/components/ui/`), plain
React + Tailwind. **New dependencies: `lucide-react` only** (icons — one
tree-shakeable dep replaces dozens of hand-drawn SVGs). No chart library, no
animation library, no headless-UI library — the set below is small enough to
own, and CSS covers the motion (§7).

### Primitives

- **Button** — variants: `primary` (brand yellow bg, ink text), `secondary`
  (surface, hairline border), `ghost`, `danger` (danger text, danger border on
  hover). Sizes: `sm` 28px, `md` 36px, `lg` 44px (POS). Hover: background
  wash + 120ms; active: scale 0.98. Focus: 2px outline offset 2 (existing
  pattern, keep).
- **Input / Select / Textarea** — 36px, surface bg, `--color-line-2` border,
  focus border ink + subtle ring. Inline error text below, danger border.
  Native `<select>`, native `<input type="date">` — no custom pickers.
- **Badge** — pill, 11px medium; status variants map to §2 status; neutral
  variant for roles/methods (DETERMINISTIC/STATISTICAL, CASH/UPI/CARD).
- **Card** — surface, border, radius 12, p-5; optional header row (heading +
  action). Hoverable variant (list-item cards): border darkens + translateY(-1px), 120ms.
- **Table** — full-bleed inside card; 12px uppercase label header row with
  hairline underline; 40px rows; row hover wash; numeric columns
  right-aligned tabular; sticky header on scroll. Row click = navigate where
  a detail exists.
- **Tabs / SegmentedControl** — segmented: pill container in `surface-2`, the
  active thumb is a `surface` pill that **slides** between options (single
  element, `transition: transform`). Used for ranges (Today/7d/30d/90d),
  Marketing (Coupons/Segments), Staff (Team/Attendance).
- **Modal** — centered ≤480px, radius 16, backdrop `rgb(0 0 0 / 0.4)` +
  4px blur; opens 180ms scale 0.97→1 + fade; closes 120ms. Focus-trapped,
  Esc closes, `<dialog>` element (native focus/inert semantics for free).
- **Sheet** — right-side panel 420px for detail views (order detail,
  customer detail, ingredient ledger); slides in 240ms. Keeps list context
  behind it — replaces "navigate away to see one row".
- **Toast** — bottom-right stack, surface + border + shadow, slides up +
  fade, auto-dismiss 4s, status icon. One component, used everywhere
  (replaces inline success `<p>`s).
- **Skeleton** — `surface-2` blocks with a slow (1.6s) shimmer sweep;
  composed into per-page skeletons shaped like the real layout (stat row,
  chart block, table rows).
- **EmptyState** — centered in card: icon (ink-3), one-line heading, one-line
  body, optional CTA. Every module has one with copy naming the action that
  produces data ("Take your first order in POS →").
- **StatCard** — label (12px uppercase), display-size value with **count-up**
  (see §7), optional delta chip (▲/▼ + success/danger text — icon + color,
  never color alone), optional 40px sparkline (slot-1, area fill 8%).
- **ConfirmDialog** — Modal preset for destructive/irreversible acts (void
  order, deactivate coupon): names the consequence, requires typed reason
  where the API takes one (void reason).
- **CommandPalette** — global Ctrl/Cmd+K (added at user request during D2).
  Linear/Raycast-style: top-anchored dialog on the Modal system, keyboard-first
  (↑↓/Enter/Esc), searches navigation targets always and existing backend
  entities (orders, customers, products, ingredients, coupons, staff) on ≥2
  chars — customers via the server's `?q=`, the rest fetched once per open and
  filtered client-side. Role-gated like the sidebar; failed fetches degrade to
  empty groups, never errors. Results navigate to module pages (deep-linking
  into detail sheets arrives with D6/D8 via `?id=`). No new dependencies.

### Chart kit (`src/components/charts/`, hand-rolled SVG)

Data volumes are tiny (≤ 90 points daily, 24 hourly, ≤ 8 categories) — a
chart library buys nothing but bundle weight and fights our motion rules.
Four components + shared bits (axis, tooltip, legend):

- **AreaLine** — revenue/customer-growth over time. 2px line, 8% area fill,
  crosshair + tooltip on hover (nearest point, dot marker ≥8px), draw-in via
  stroke-dashoffset 400ms. X ticks thinned to ~6; y-axis 3–4 gridlines,
  labels formatted (₹1.2k).
- **Bars** — vertical; hourly sales (24 IST buckets). 4px rounded top ends
  anchored to baseline, 2px gap min, grow-in scaleY staggered ≤ 300ms total;
  per-bar hover tooltip; peak bar direct-labeled.
- **RowBars** — horizontal; top products, payment breakdown, segment sizes.
  Label left, bar + value right (direct-labeled always — this is the §2
  relief rule). Nominal bars all wear slot 1; only true multi-series uses
  slots 1..N.
- **Sparkline** — 40px, no axes, no tooltip; StatCard only.

Charts always ship: direct value labels or tooltip, an accessible fallback
(`<title>`/aria description + the data already visible in an adjacent table
where one exists), and honest zero states (no data → EmptyState, never an
empty axis frame).

---

## 5. Navigation & app shell

**Desktop: fixed left sidebar, 240px**, `--color-page` background (chrome sits
on page, content cards sit on surface — subtle two-plane depth with almost no
shadow).

```
┌────────────┬──────────────────────────────────────┐
│ ⬤ OraOS    │  {page title}            {actions}   │
│ RestaurantX│                                      │
│  ▾ switch  │  ┌────────┐ ┌────────┐ ┌────────┐    │
│            │  │ stat   │ │ stat   │ │ stat   │    │
│ OPERATE    │  └────────┘ └────────┘ └────────┘    │
│  POS       │                                      │
│  Orders    │  ┌──────────────────────────────┐    │
│  Kitchen   │  │ content cards                │    │
│ UNDERSTAND │  └──────────────────────────────┘    │
│  Analytics │                                      │
│  Reports   │                                      │
│ GROW       │                                      │
│  Customers │                                      │
│  Marketing │                                      │
│ MANAGE     │                                      │
│  Inventory │                                      │
│  Staff     │                                      │
│ INTELLIGENCE                                      │
│  AI Center │                                      │
│ ──────────┤                                       │
│ ⚙ Settings │                                      │
│ ◑ user ▾   │                                      │
└────────────┴──────────────────────────────────────┘
```

- Groups mirror the blueprint's product loop (§1: record → understand → act):
  **Operate** (POS, Orders, Kitchen), **Understand** (Analytics, Reports),
  **Grow** (Customers, Marketing), **Manage** (Inventory, Staff),
  **Intelligence** (AI Center). Group labels: 12px uppercase ink-3.
- Items: 32px rows, icon 16px + label 14px. Active: `surface` pill +
  medium weight + 2px brand left rail. Hover: wash. The active pill
  **slides** between items (same segmented-thumb technique).
- Top: wordmark + restaurant name; clicking opens the **restaurant
  switcher** (memberships list from `/auth/me`; selecting calls existing
  `POST /auth/select-restaurant`). One membership → static label.
- Bottom: Settings link + user menu (name, role badge, sign out).
- **Role-aware (UX only, server enforces):** CASHIER sees Operate + Customers;
  KITCHEN sees Kitchen only and lands there; MANAGER/OWNER see all. Filtering
  keys off role name from `/auth/me` — cosmetic; API + RLS remain the boundary.
- Collapse: chevron collapses to 64px icon rail (labels become tooltips);
  state in `localStorage`.
- **Full-bleed modes:** POS and Kitchen render edge-to-edge with the sidebar
  auto-collapsed to the icon rail — tablets need the pixels.
- Mobile (<768px): sidebar becomes a left sheet behind a top-bar hamburger;
  top bar shows wordmark + restaurant + avatar.

Header per page: title (20px) left; page-scope actions right (range control,
export, "New X" primary button). No breadcrumbs — hierarchy is one level deep
everywhere except detail sheets, which show their own back affordance.

---

## 6. Page layouts (every existing module)

Specs below use only existing endpoints (ROADMAP §"What exists now").

### Login `/login`
Split screen: left 45% brand panel (page-dark surface, wordmark, one line of
product copy, subtle animated yellow orb-gradient — the single decorative
element in the app); right 55% centered 360px form card-less on page bg:
title, email, password, primary button full-width, error inline. Entrance:
form children fade-up staggered 40ms. No signup link changes, no new flows.

### Restaurant Selection
Not a route today (shell auto-picks `memberships[0]`) — becomes a real step
only in the switcher (§5) *and* a full-screen picker when `memberships.length > 1`
on first load: centered list of restaurant cards (name, role badge), click →
`select-restaurant` → dashboard. One membership: skip entirely, as now.

### Dashboard `/dashboard`
Today it's an empty shell; make it the daily read using **existing**
`GET /analytics/overview?range=today` + `/ai/insights`:
- Greeting row: "Good morning, {name}" + date (IST).
- 4 StatCards: Revenue today, Orders today, Avg bill, Items sold (count-up,
  sparkline from the 7d series fetched once).
- Two-up: AreaLine "Last 7 days revenue" · RowBars "Today's top items".
- "Attention" card: top 3 AI insights (severity icon, one-liner, link to AI
  Center) — the blueprint's "what should I do next" surfaced on the home.
- Quick actions row: New order (POS), View kitchen, Today's report.
Cold start: EmptyStates with CTAs, never zeros pretending to be data.

### POS `/dashboard/pos`
Full-bleed two-pane. Left: category chips row (horizontal scroll, segmented
style) + product grid (tiles 120px min, name + price, tap = add, quantity
badge animates on change; keyboard `/` focuses search). Right: order panel
360px — line items (qty steppers, swipe/× remove), customer attach
(existing picker, restyled as combobox), coupon code field (server computes),
totals block (subtotal/discount/tax/total, tabular), payment method
segmented (CASH/UPI/CARD), big 52px "Charge ₹X" primary button. Item-add
micro-interaction: tile pulses once; line item fade-up; total counts up.
Success: total flips to a ✓ state 800ms, panel resets. Design targets
tablet-landscape first. Offline is Phase 2 — no offline UI invented now.

### Orders `/dashboard/orders`
Toolbar: status filter segments (All/Active/Completed/Voided) + search.
Table: ID (mono), time, customer, items count, total, payment, status badge.
Row click → right Sheet: header (ID, badge, total), line items, payments,
**timeline** (from `order_events`) as a vertical rail — dot + event + time,
newest animating in; status-transition buttons per the state machine
whitelist; Void behind ConfirmDialog with reason. New orders (socket) slide
in at table top with a brief highlight wash.

### Kitchen `/dashboard/kitchen`
Full-bleed dark-preferred board (KDS is a wall screen — always render dark
tokens regardless of scheme). Columns by state (Placed / In progress /
Ready). Ticket cards: order # large, elapsed-time chip that escalates
neutral → warning (>10m) → danger (>20m) with a subtle pulse only at danger,
items with quantities, action button advances state. New ticket: slides in
from left column top + single soft tone-free flash. Column counts in
headers. Touch targets 48px+.

### Customers `/dashboard/customers`
Header stats: total customers, new this month (from list data). Toolbar:
search by name/phone (uses by-phone lookup for exact), "New customer".
Table: name, phone (mono), orders, spend, last order. Row → Sheet: profile,
edit inline (existing PATCH), derived stats row, recent orders list linking
to Orders. Segment chips shown on profile if the customer appears in a
marketing segment (existing segments endpoint).

### Inventory `/dashboard/inventory`
Stats row: ingredients count, low-stock count (warning), negative-stock
count (danger). Table: ingredient, current stock (SUM presented in display
units via `lib/units.ts`), reorder state badge. Row → Sheet: movement ledger
(append-only list: type badge, signed qty, time, order link for
CONSUMPTION), "Record purchase/adjustment" forms (existing endpoints).
Recipe editor stays a per-product modal (existing flow, restyled): product →
ingredient rows with base-unit quantities. Negative stock shown honestly in
danger — reality wins over bookkeeping (roadmap rule), never clamped to 0.

### Staff `/dashboard/staff` (+ Attendance)
Segmented tabs: **Team** · **Attendance**. Team: member cards/table (name,
role badge, status), invite flow → modal generating the join link (mono,
copy button), pending invites list with revoke. Role changes via existing
PATCH; OWNER never assignable (API rule — UI doesn't offer it). Attendance:
"Who's on shift now" derived strip (avatar chips), my clock-in/out big
button (existing `me/clock`), timesheet table with date range (native date
inputs) from existing timesheet endpoint. Append-only: corrections add
entries; UI shows correction entries as such, never edits rows.

### Analytics `/dashboard/analytics`
Range segmented control (Today/7/30/90) top-right. Stats row (4 StatCards
with deltas vs previous period only if the API provides them — it doesn't,
so v1: no deltas, no fabrication). Grid: AreaLine revenue-per-day (2-col
span), Bars hourly orders (peak labeled), RowBars top products, RowBars
payment breakdown (direct-labeled %). All charts animate on range change
(data morph = re-draw with 240ms transition on bar heights / line path).

### Reports `/dashboard/reports`
Left card: native from/to date inputs + presets (This week / month / Last
month) + "Run report". Result: summary StatCards + the same chart kit over
the custom window + line-items table. "Export CSV" secondary button hits
the existing CSV endpoint. Skeleton while running.

### AI Center `/dashboard/ai`
Insight cards in a single column, grouped by severity. Each card: method
badge (DETERMINISTIC/STATISTICAL — info/neutral), confidence badge (LOW =
warning), headline, and an expandable **"Based on"** section revealing the
`basis` numbers (expand/collapse animation) — the transparency rule made
visible. Forecast cards show the 14-day moving-average number with its
confidence; cold-start shows the honest "not enough history yet, N days to
go" EmptyState. No chat UI — the LLM advisor doesn't exist yet and the
design must not pretend it does.

### Marketing `/dashboard/marketing` (+ Coupons)
Segmented tabs: **Coupons** · **Segments**. Coupons: table (code in mono,
rule summary, validity, redemptions x/max, active badge), "New coupon" modal
(existing POST fields only), deactivate via PATCH + ConfirmDialog.
Segments: four fixed segment cards (VIP/Regular/New/Lapsed) with count,
**the rule stated on the card** (deterministic — the rule is the feature),
click → customer list for that segment. Recommendations, where surfaced,
carry an "advisory" label per the non-negotiable.

### Settings `/dashboard/settings` (new route, existing data only)
v1 is honest about the backend: Restaurant card (name, read-only — no PATCH
endpoint exists), Profile card (name/email from `/auth/me`, read-only),
Session card (role, restaurant, sign out everywhere = existing logout).
When settings endpoints exist, sections activate. Do not build fake toggles.

### Audit Logs
**Blocked: no `GET /audit-logs` endpoint exists.** Design spec (for when it
does): filterable table (actor, action, entity, time), append-only framing,
no delete affordances anywhere. Not built until the API ships — a UI over a
nonexistent endpoint violates the fit-the-backend rule.

### Landing `/` and Setup `/setup` and Join `/join/[token]`
Restyle with the same tokens: landing gets the brand panel treatment (hero,
three feature cards, footer — structure unchanged); setup/join become
centered single-card flows with the Login entrance motion.

---

## 7. Motion guidelines

CSS-only (transitions, keyframes, `@starting-style`), one rAF hook for
counters, View Transitions for route changes. No animation library.

**Tokens** (as `@theme` custom properties):

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 120ms | hovers, presses, color/border changes |
| `--dur-2` | 180ms | modals, dropdowns, segmented thumb |
| `--dur-3` | 240ms | sheets, page content entrance, expand/collapse |
| `--dur-4` | 400ms | chart draw-in, counters (counters cap 600ms) |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | all entrances |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | thumb slides, morphs |

**Patterns:**
- **Page transitions:** Next 16 View Transitions API if the experimental flag
  proves stable in our CSP/force-dynamic setup (verify at implementation);
  fallback: main pane content plays `fade-up` (opacity 0→1, translateY 6px,
  240ms) keyed on pathname. Sidebar/header never re-animate.
- **Shared element:** the nav active pill and segmented thumbs slide rather
  than jump (transform transition on a single element — the cheap, reliable
  form of shared-element transition). Sheet open keeps the originating row
  highlighted.
- **Stagger:** entrance lists stagger 40ms/item, capped at 8 items (past 8,
  the rest appear together — long staggers read as slowness).
- **Counters:** `useCountUp` rAF hook (~15 lines), ease-out, 600ms max,
  formats through `lib/money.ts`; skipped entirely under reduced motion.
- **Skeletons:** shimmer 1.6s linear infinite; skeleton→content swap is a
  120ms cross-fade, layout-stable (skeletons match final dimensions).
- **Expand/collapse:** grid-template-rows `0fr→1fr` technique, 240ms.
- **Charts:** draw once on mount + on data change; never re-animate on
  unrelated re-renders (key by range). Bars scaleY from baseline; lines
  stroke-dash draw; tooltips follow instantly (no lag on pointer).
- **Toasts/KDS tickets:** translate from their arrival edge + fade, 240ms.
- **Performance floor:** animate only `transform` and `opacity` (exceptions:
  border-color/background on `--dur-1` hovers). No `width/height/top/left`
  animation. Respect `prefers-reduced-motion: reduce` globally: durations →
  0ms except opacity fades ≤120ms.

---

## 8. Responsiveness

Breakpoints (Tailwind defaults): `<768` phone, `768–1024` tablet,
`>1024` desktop. Desktop-first CSS is fine under Tailwind's mobile-first
utilities — design intent is desktop-first, markup handles both.

| Surface | Desktop | Tablet | Phone |
|---|---|---|---|
| Shell | fixed sidebar 240px | icon rail 64px | top bar + sheet nav |
| Stat rows | 4-up | 2-up | 2-up |
| Chart grids | 2-col | 1-col | 1-col |
| Tables | full columns | drop tertiary columns | card-list rows (label/value pairs) |
| Detail Sheets | 420px overlay | 420px overlay | full-screen sheet |
| POS | two-pane | two-pane (primary target) | grid + bottom-sheet cart |
| KDS | columns | columns (primary target) | single column, state filter chips |

Touch: 44px minimum targets on POS/KDS (buttons `lg`), `touch-action:
manipulation` global rule stays.

---

## 9. Implementation plan (after approval — one module at a time)

Tech decisions locked above: **one new dependency (`lucide-react`)**, CSS
motion, hand-rolled SVG charts, native `<dialog>`/`<select>`/date inputs,
Tailwind 4 `@theme` tokens. Each step ends green (`pnpm typecheck && pnpm
build`) + browser-verified in light/dark, per existing working rules.

| # | Step | Contents |
|---|---|---|
| D1 | Foundations | tokens in `globals.css`, Button/Input/Badge/Card/Skeleton/EmptyState/Toast/Modal/Sheet/Table/Segmented, `useCountUp` |
| D2 | Shell & nav | sidebar, groups, active pill, restaurant switcher, role-aware filtering, collapse, mobile sheet, page transitions, command palette (Ctrl+K), read-only settings route |
| D3 | Dashboard home | StatCards + chart kit (AreaLine, Bars, RowBars, Sparkline) — the kit is built here where it's first consumed |
| D4 | Analytics + Reports | full chart pages on the now-existing kit |
| D5 | POS | two-pane redesign, tablet pass |
| D6 | Orders | table + detail sheet + timeline |
| D7 | Kitchen | KDS board, always-dark, escalation chips |
| D8 | Customers · Inventory · Staff | tables + sheets + ledgers |
| D9 | AI Center · Marketing | insight cards, coupon/segment tabs |
| D10 | Auth & edges | login, setup, join, landing, settings route, multi-restaurant picker, polish + reduced-motion audit |

Deferred by design: dark-mode toggle, Audit Logs UI (needs API), offline UI
(Phase 2), LLM chat surface (no backend), notification center (no
notifications API — Toasts only for now).
