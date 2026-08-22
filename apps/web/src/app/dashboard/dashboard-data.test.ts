import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileDashboardLoad } from './dashboard-data.ts';

// Minimal settled results — the helper only reads a handful of fields, so the
// `never` casts keep the test free of the full API types (and of api.ts).
const ok = <T>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value });
const rejected = (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason });

const analytics = () => ok({} as never);
const insights = (arr: Array<{ severity: string }> = []) => ok({ insights: arr } as never);
const ingredients = (n: number) => ok(Array.from({ length: n }) as never);
const orders = (rows: Array<{ status: string }> = []) => ok(rows as never);
const me = (name: string) => ok({ user: { name } } as never);

const apiError = (message: string) => ({ name: 'ApiRequestError', message });

test('all six succeed → full dashboard, orders filtered to active statuses', () => {
  const load = reconcileDashboardLoad({
    today: analytics(),
    week: analytics(),
    insights: insights([{ severity: 'info' }, { severity: 'warning' }]),
    ingredients: ingredients(3),
    active: orders([{ status: 'PLACED' }, { status: 'COMPLETED' }, { status: 'READY' }]),
    me: me('Chandrashekhar Gade'),
  });
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.equal(load.lowStock, 3);
  assert.equal(load.firstName, 'Chandrashekhar');
  // COMPLETED is not an active status; PLACED + READY survive.
  assert.deepEqual(
    load.active?.map((o) => o.status),
    ['PLACED', 'READY'],
  );
  // warning insights sort ahead of info.
  assert.equal(load.insights[0].severity, 'warning');
});

// THE regression: this is the exact production failure. /orders returned 500
// while the five other calls returned 200. The old Promise.all rejected the
// whole batch and blanked the page. Now the page still renders and only the
// orders widget is flagged.
test('orders 500 but core analytics OK → page renders, orders widget flagged', () => {
  const load = reconcileDashboardLoad({
    today: analytics(),
    week: analytics(),
    insights: insights(),
    ingredients: ingredients(0),
    active: rejected(apiError('An unexpected error occurred.')),
    me: me('Ada'),
  });
  assert.equal(load.ok, true, 'a single failed widget must not blank the dashboard');
  if (!load.ok) return;
  assert.equal(load.active, null, 'active === null signals an explicit widget error, not "no orders"');
  assert.equal(load.firstName, 'Ada');
});

test('any side widget can fail independently and the page still renders', () => {
  const load = reconcileDashboardLoad({
    today: analytics(),
    week: analytics(),
    insights: rejected(apiError('boom')),
    ingredients: rejected(apiError('boom')),
    active: orders([{ status: 'PLACED' }]),
    me: rejected(apiError('boom')),
  });
  assert.equal(load.ok, true);
  if (!load.ok) return;
  assert.deepEqual(load.insights, []);
  assert.equal(load.lowStock, null); // low-stock brief simply hides
  assert.equal(load.firstName, ''); // greeting drops the name
  assert.equal(load.active?.length, 1);
});

test('core analytics failing → honest page error carrying the API message', () => {
  const load = reconcileDashboardLoad({
    today: analytics(),
    week: rejected(apiError('Analytics is down')),
    insights: insights(),
    ingredients: ingredients(0),
    active: orders(),
    me: me('Ada'),
  });
  assert.equal(load.ok, false);
  if (load.ok) return;
  assert.equal(load.error, 'Analytics is down');
});

test('core failing with a non-API error → generic message, never a raw error string', () => {
  const load = reconcileDashboardLoad({
    today: rejected(new TypeError('Failed to fetch')),
    week: analytics(),
    insights: insights(),
    ingredients: ingredients(0),
    active: orders(),
    me: me('Ada'),
  });
  assert.equal(load.ok, false);
  if (load.ok) return;
  assert.equal(load.error, 'Could not load the dashboard');
});
