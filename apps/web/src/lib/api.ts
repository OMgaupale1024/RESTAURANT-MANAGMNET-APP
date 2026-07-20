const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/api/v1';

export type ApiError = {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
};

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(
      Array.isArray(body?.message)
        ? body.message.join(', ')
        : (body?.message ?? 'Request failed'),
    );
    this.name = 'ApiRequestError';
  }
}

/**
 * Calls the OraOS API.
 *
 * `credentials: 'include'` is required for the refresh cookie to travel: the
 * web app and API are different origins (different port in dev, likely
 * different subdomain in production). The API answers with an explicit CORS
 * allowlist, never a reflected origin, which is what makes this safe.
 */
export async function apiFetch<T>(
  path: string,
  options: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const { accessToken, headers, ...rest } = options;

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(res.status, body as ApiError | null);
  return body as T;
}

/**
 * Single-flight refresh (backlog #11).
 *
 * Access tokens last 15 minutes; a POS session lasts a shift. Without this,
 * the first call after expiry fails and the cashier is bounced to /login
 * mid-order.
 *
 * The in-flight promise is shared deliberately. Refresh tokens rotate with
 * reuse detection (Step 5), so two concurrent refreshes would send the same
 * token twice — the second read as theft, revoking the family and logging the
 * user out. One refresh at a time, everyone awaits the same result.
 *
 * This adds no credential and no storage. It calls the same endpoint the app
 * already uses on load.
 */
let inFlightRefresh: Promise<string> | null = null;

export function refreshOnce(): Promise<string> {
  if (!inFlightRefresh) {
    inFlightRefresh = refreshSession()
      .then((r) => r.accessToken)
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

/**
 * apiFetch that transparently refreshes once on 401 and retries.
 *
 * Only 401 triggers a retry. A 403 means authenticated-but-not-permitted —
 * refreshing would change nothing and would hide a real permissions bug.
 */
export async function authedFetch<T>(
  path: string,
  accessToken: string,
  onNewToken: (token: string) => void,
  options: RequestInit = {},
): Promise<T> {
  try {
    return await apiFetch<T>(path, { ...options, accessToken });
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.status !== 401) throw err;

    // Expired, not forged. Try exactly one refresh, then retry once.
    const fresh = await refreshOnce();
    onNewToken(fresh);
    return apiFetch<T>(path, { ...options, accessToken: fresh });
  }
}

export type LoginResponse = {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
};

export type MeResponse = {
  user: { id: string; email: string; name: string; createdAt: string };
  memberships: Array<{
    id: string;
    restaurant: { id: string; name: string; slug: string };
    role: { key: string; name: string };
  }>;
};

export const login = (email: string, password: string) =>
  apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

/**
 * Starts a password reset. Resolves the same way whether or not the email has
 * an account — the API never reveals which addresses are registered, so the UI
 * must show one message regardless.
 */
export const forgotPassword = (email: string) =>
  apiFetch<void>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });

/** Completes a password reset. Throws ApiRequestError (400) on an invalid or expired link. */
export const resetPassword = (token: string, password: string) =>
  apiFetch<void>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });

export const getMe = (accessToken: string) =>
  apiFetch<MeResponse>('/auth/me', { accessToken });

export type CreateRestaurantResponse = {
  restaurant: { id: string; name: string; slug: string; createdAt: string };
  branch: { id: string; name: string; address: string | null };
  membershipId: string;
};

export const createRestaurant = (
  accessToken: string,
  body: { name: string; branchName?: string; branchAddress?: string },
) =>
  apiFetch<CreateRestaurantResponse>('/restaurants', {
    method: 'POST',
    accessToken,
    body: JSON.stringify(body),
  });

/** Swaps the token for one scoped to a restaurant. Membership is verified server-side. */
export const selectRestaurant = (accessToken: string, restaurantId: string) =>
  apiFetch<LoginResponse>('/auth/select-restaurant', {
    method: 'POST',
    accessToken,
    body: JSON.stringify({ restaurantId }),
  });

/**
 * Exchanges the httpOnly refresh cookie for a fresh access token.
 * No argument: the browser supplies the cookie, JS never sees it.
 */
export const refreshSession = () =>
  apiFetch<LoginResponse>('/auth/refresh', { method: 'POST' });

export const logout = () =>
  apiFetch<void>('/auth/logout', { method: 'POST' });

/**
 * Ends every session for this user, on every device — what the Settings card
 * says it does. Needs the access token: `logout` is public because the cookie
 * is the credential, but revoking all sessions has to prove who is asking.
 */
export const logoutAll = (accessToken: string) =>
  apiFetch<void>('/auth/logout-all', { method: 'POST', accessToken });

export type Product = {
  id: string;
  name: string;
  priceMinor: number;
  taxRateBp: number;
  categoryId: string | null;
};

export type Order = {
  id: string;
  orderNumber: number;
  status: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  notes: string | null;
  placedAt: string | null;
  createdAt: string;
  items: Array<{
    id: string;
    nameSnapshot: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    notes: string | null;
  }>;
  payments: Array<{ id: string; method: string; status: string; amountMinor: number }>;
  customer: { id: string; name: string; phone: string } | null;
};

type Retry = (t: string) => void;

export const listProducts = (token: string, onNewToken: Retry) =>
  authedFetch<Product[]>('/products', token, onNewToken);

export type Category = { id: string; name: string };

export const listCategories = (token: string, onNewToken: Retry) =>
  authedFetch<Category[]>('/categories', token, onNewToken);

export const createProduct = (
  token: string,
  onNewToken: Retry,
  body: { name: string; priceMinor: number },
) =>
  authedFetch<Product>('/products', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const createOrder = (
  token: string,
  onNewToken: Retry,
  body: {
    items: Array<{ productId: string; quantity: number }>;
    paymentMethod?: string;
    customerId?: string;
    couponCode?: string;
    notes?: string;
    idempotencyKey?: string;
  },
) =>
  authedFetch<Order>('/orders', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export type OrderSummary = {
  id: string;
  orderNumber: number;
  status: string;
  totalMinor: number;
  createdAt: string;
  placedAt: string | null;
  notes: string | null;
  _count: { items: number };
  customer: { name: string } | null;
  payments: Array<{ method: string; status: string }>;
  items: Array<{ nameSnapshot: string; quantity: number; notes: string | null }>;
};

export type TimelineEvent = {
  id: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export const listOrders = (token: string, onNewToken: Retry, status?: string) =>
  authedFetch<OrderSummary[]>(
    status ? `/orders?status=${encodeURIComponent(status)}` : '/orders',
    token,
    onNewToken,
  );

export const getOrder = (token: string, onNewToken: Retry, id: string) =>
  authedFetch<Order>(`/orders/${id}`, token, onNewToken);

export const getTimeline = (token: string, onNewToken: Retry, id: string) =>
  authedFetch<TimelineEvent[]>(`/orders/${id}/timeline`, token, onNewToken);

export const updateOrderStatus = (
  token: string,
  onNewToken: Retry,
  id: string,
  status: string,
  reason?: string,
) =>
  authedFetch<Order>(`/orders/${id}/status`, token, onNewToken, {
    method: 'PATCH',
    body: JSON.stringify(reason ? { status, reason } : { status }),
  });

/** Deterministic marketing segment, computed server-side (never on the client). */
export type CustomerSegment = { key: string; label: string; rule: string };

export type CustomerSummary = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  createdAt: string;
  stats: {
    visits: number;
    totalSpentMinor: number;
    averageBillMinor: number;
    lastVisit: string | null;
  };
  /** Null until the customer has a countable order. */
  segment: CustomerSegment | null;
};

export type CustomerDetail = CustomerSummary & {
  birthday: string | null;
  notes: string | null;
  stats: {
    visits: number;
    totalSpentMinor: number;
    averageBillMinor: number;
    firstVisit: string | null;
    lastVisit: string | null;
  };
  recentOrders: Array<{
    id: string;
    orderNumber: number;
    status: string;
    totalMinor: number;
    createdAt: string;
  }>;
};

export const listCustomers = (token: string, onNewToken: Retry, q?: string) =>
  authedFetch<CustomerSummary[]>(
    q ? `/customers?q=${encodeURIComponent(q)}` : '/customers',
    token,
    onNewToken,
  );

export const getCustomer = (token: string, onNewToken: Retry, id: string) =>
  authedFetch<CustomerDetail>(`/customers/${id}`, token, onNewToken);

export const findCustomerByPhone = (
  token: string,
  onNewToken: Retry,
  phone: string,
) =>
  authedFetch<{ id: string; name: string; phone: string } | Record<string, never>>(
    `/customers/by-phone/${encodeURIComponent(phone)}`,
    token,
    onNewToken,
  );

export const createCustomer = (
  token: string,
  onNewToken: Retry,
  body: { name: string; phone: string; email?: string },
) =>
  authedFetch<CustomerSummary>('/customers', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** Null clears a field; undefined leaves it untouched (server contract). */
export const updateCustomer = (
  token: string,
  onNewToken: Retry,
  id: string,
  body: {
    name?: string;
    phone?: string;
    email?: string | null;
    birthday?: string | null;
    notes?: string | null;
  },
) =>
  authedFetch<unknown>(`/customers/${id}`, token, onNewToken, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export type StockUnit = 'GRAM' | 'MILLILITRE' | 'PIECE';

export type IngredientRow = {
  id: string;
  name: string;
  unit: StockUnit;
  reorderLevel: number | null;
  currentStock: number;
  isLow: boolean;
  lastMovementAt: string | null;
  /** 7-day CONSUMPTION average in base units per day. */
  avgDailyUsage: number;
};

export type IngredientDetail = Omit<IngredientRow, 'isLow'> & {
  isLow: boolean;
  movements: Array<{
    id: string;
    type: string;
    quantity: number;
    note: string | null;
    orderId: string | null;
    createdAt: string;
  }>;
};

export const listIngredients = (token: string, onNewToken: Retry, lowOnly?: boolean) =>
  authedFetch<IngredientRow[]>(
    lowOnly ? '/ingredients?lowStock=true' : '/ingredients',
    token,
    onNewToken,
  );

export const getIngredient = (token: string, onNewToken: Retry, id: string) =>
  authedFetch<IngredientDetail>(`/ingredients/${id}`, token, onNewToken);

export const createIngredient = (
  token: string,
  onNewToken: Retry,
  body: { name: string; unit: StockUnit; reorderLevel?: number },
) =>
  authedFetch<IngredientRow>('/ingredients', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** A signed stock count correction — appended to the ledger, never a rewrite. */
export const recordAdjustment = (
  token: string,
  onNewToken: Retry,
  id: string,
  body: { quantity: number; note?: string; idempotencyKey?: string },
) =>
  authedFetch<unknown>(`/ingredients/${id}/adjustments`, token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const recordMovement = (
  token: string,
  onNewToken: Retry,
  id: string,
  body: {
    type: 'PURCHASE' | 'WASTE';
    quantity: number;
    note?: string;
    idempotencyKey?: string;
  },
) =>
  authedFetch<unknown>(`/ingredients/${id}/movements`, token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export type RecipeResponse = {
  product: { id: string; name: string };
  items: Array<{
    id: string;
    quantity: number;
    ingredient: { id: string; name: string; unit: StockUnit };
  }>;
};

export const getRecipe = (token: string, onNewToken: Retry, productId: string) =>
  authedFetch<RecipeResponse>(`/products/${productId}/recipe`, token, onNewToken);

export const setRecipe = (
  token: string,
  onNewToken: Retry,
  productId: string,
  items: Array<{ ingredientId: string; quantity: number }>,
) =>
  authedFetch<unknown>(`/products/${productId}/recipe`, token, onNewToken, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });

export type StaffMember = {
  id: string;
  isActive: boolean;
  onShift: boolean;
  lastEventAt: string | null;
  user: { id: string; name: string; email: string };
  role: { key: string; name: string };
};

export type PendingInvite = {
  id: string;
  email: string;
  expiresAt: string;
  role: { key: string; name: string };
};

export const listStaff = (token: string, onNewToken: Retry) =>
  authedFetch<StaffMember[]>('/staff', token, onNewToken);

export const listInvites = (token: string, onNewToken: Retry) =>
  authedFetch<PendingInvite[]>('/staff/invites', token, onNewToken);

export const createInvite = (
  token: string,
  onNewToken: Retry,
  body: { email: string; role: string },
) =>
  authedFetch<{ inviteUrl: string; email: string }>('/staff/invites', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const revokeInvite = (token: string, onNewToken: Retry, id: string) =>
  authedFetch<unknown>(`/staff/invites/${id}`, token, onNewToken, { method: 'DELETE' });

export const updateMember = (
  token: string,
  onNewToken: Retry,
  id: string,
  body: { role?: string; isActive?: boolean },
) =>
  authedFetch<StaffMember>(`/staff/${id}`, token, onNewToken, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

export const clockSelf = (token: string, onNewToken: Retry, type: 'CLOCK_IN' | 'CLOCK_OUT') =>
  authedFetch<unknown>('/staff/me/clock', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify({ type }),
  });

export type TimesheetEntry = {
  membershipId: string;
  name: string;
  role: string;
  sessions: Array<{ in: string; out: string | null; minutes: number | null }>;
  totalMinutes: number;
  openSession: boolean;
};

export const getTimesheet = (
  token: string,
  onNewToken: Retry,
  opts: { from?: string; to?: string; membershipId?: string } = {},
) => {
  const params = new URLSearchParams();
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.membershipId) params.set('membershipId', opts.membershipId);
  const qs = params.toString();
  return authedFetch<TimesheetEntry[]>(
    qs ? `/staff/timesheet?${qs}` : '/staff/timesheet',
    token,
    onNewToken,
  );
};

export const clockMember = (
  token: string,
  onNewToken: Retry,
  id: string,
  type: 'CLOCK_IN' | 'CLOCK_OUT',
) =>
  authedFetch<unknown>(`/staff/${id}/clock`, token, onNewToken, {
    method: 'POST',
    body: JSON.stringify({ type }),
  });

/** PUBLIC — no token: the invitee has no account yet. */
export const describeInvite = (inviteToken: string) =>
  apiFetch<{
    email: string;
    restaurantName: string;
    role: { key: string; name: string };
  }>(`/join/${inviteToken}`);

export const acceptInvite = (
  inviteToken: string,
  body: { name: string; password: string },
) =>
  apiFetch<LoginResponse>(`/join/${inviteToken}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** Active kitchen orders (PLACED/PREPARING/READY), for the kitchen display. */
export const listActiveOrders = (token: string, onNewToken: Retry) =>
  authedFetch<OrderSummary[]>('/orders?limit=100', token, onNewToken);

export type AnalyticsOverview = {
  range: string;
  from: string;
  to: string;
  summary: {
    revenueMinor: number;
    orders: number;
    averageBillMinor: number;
    itemsSold: number;
  };
  revenueSeries: Array<{ date: string; revenueMinor: number; orders: number }>;
  topProducts: Array<{ name: string; quantity: number; revenueMinor: number }>;
  paymentBreakdown: Array<{ method: string; amountMinor: number; count: number }>;
  peakHours: Array<{ hour: number; orders: number }>;
};

export const getAnalytics = (token: string, onNewToken: Retry, range: string) =>
  authedFetch<AnalyticsOverview>(
    `/analytics/overview?range=${encodeURIComponent(range)}`,
    token,
    onNewToken,
  );

/** A sales report for an explicit date window. Same shape as the overview, minus the preset `range`. */
export type SalesReport = Omit<AnalyticsOverview, 'range'>;

export const getSalesReport = (
  token: string,
  onNewToken: Retry,
  from: string,
  to: string,
) =>
  authedFetch<SalesReport>(
    `/reports/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    token,
    onNewToken,
  );

export type AiInsight = {
  type: string;
  method: 'DETERMINISTIC' | 'STATISTICAL' | 'LLM';
  severity: 'info' | 'warning';
  title: string;
  detail: string;
  basis: string;
  confidence?: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
};

export const getInsights = (token: string, onNewToken: Retry) =>
  authedFetch<{ generatedAt: string; insights: AiInsight[] }>(
    '/ai/insights',
    token,
    onNewToken,
  );

export type Coupon = {
  id: string;
  code: string;
  type: 'PERCENT' | 'FIXED';
  percentBp: number | null;
  amountMinor: number | null;
  maxDiscountMinor: number | null;
  minSubtotalMinor: number;
  maxRedemptions: number | null;
  validFrom: string | null;
  validUntil: string | null;
  isActive: boolean;
  createdAt: string;
  _count?: { redemptions: number };
};

export type Segment = { key: string; label: string; rule: string; count: number };
export type SegmentsResponse = {
  segments: Segment[];
  recommendations: Array<{
    method: string;
    title: string;
    detail: string;
    basis: string;
  }>;
};

export const listCoupons = (token: string, onNewToken: Retry) =>
  authedFetch<Coupon[]>('/marketing/coupons', token, onNewToken);

export const createCoupon = (
  token: string,
  onNewToken: Retry,
  body: {
    code: string;
    type: 'PERCENT' | 'FIXED';
    percentBp?: number;
    amountMinor?: number;
    maxDiscountMinor?: number;
    minSubtotalMinor?: number;
    maxRedemptions?: number;
    validFrom?: string;
    validUntil?: string;
  },
) =>
  authedFetch<Coupon>('/marketing/coupons', token, onNewToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export type SegmentCustomer = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
};

/** The customers in one deterministic segment (VIP/REGULAR/NEW/LAPSED). */
export const segmentCustomers = (token: string, onNewToken: Retry, key: string) =>
  authedFetch<SegmentCustomer[]>(
    `/marketing/segments/${encodeURIComponent(key)}/customers`,
    token,
    onNewToken,
  );

export const setCouponActive = (
  token: string,
  onNewToken: Retry,
  id: string,
  isActive: boolean,
) =>
  authedFetch<Coupon>(`/marketing/coupons/${id}`, token, onNewToken, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });

export const getSegments = (token: string, onNewToken: Retry) =>
  authedFetch<SegmentsResponse>('/marketing/segments', token, onNewToken);
