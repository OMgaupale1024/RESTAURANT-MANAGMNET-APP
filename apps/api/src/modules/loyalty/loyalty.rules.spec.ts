import {
  DEFAULT_LOYALTY_CONFIG,
  availableReward,
  pointsForOrder,
  redemptionFor,
  validateConfig,
  type LoyaltyConfig,
} from './loyalty.rules';

/** A config with the spec's headline example rates: ₹100→10, 100pts→₹50. */
const cfg = (over: Partial<LoyaltyConfig> = {}): LoyaltyConfig => ({
  isEnabled: true,
  earnAmountMinor: 10000, // ₹100
  earnPoints: 10,
  redeemPoints: 100,
  redeemAmountMinor: 5000, // ₹50
  minimumRedeemPoints: 100,
  maximumRedeemPointsPerOrder: 500,
  ...over,
});

describe('pointsForOrder (configurable earn)', () => {
  it('earns at the configured ratio: ₹100 → 10 points on a ₹480 net order', () => {
    // floor(48000 × 10 ÷ 10000) = 48 — floors at the point, deterministic.
    expect(
      pointsForOrder({ subtotalMinor: 48000, discountMinor: 0 }, cfg()),
    ).toBe(48);
  });

  it('earns on NET spend, after discount, tax excluded', () => {
    // net 7000 at the default ₹10/point → 7.
    expect(
      pointsForOrder(
        { subtotalMinor: 10000, discountMinor: 3000 },
        DEFAULT_LOYALTY_CONFIG,
      ),
    ).toBe(7);
  });

  it('earns nothing on a zero (or fully discounted) order', () => {
    expect(pointsForOrder({ subtotalMinor: 0, discountMinor: 0 }, cfg())).toBe(
      0,
    );
    expect(
      pointsForOrder({ subtotalMinor: 5000, discountMinor: 5000 }, cfg()),
    ).toBe(0);
  });

  it('earns nothing while loyalty is disabled', () => {
    expect(
      pointsForOrder(
        { subtotalMinor: 48000, discountMinor: 0 },
        cfg({ isEnabled: false }),
      ),
    ).toBe(0);
  });

  it('preserves the legacy default rate (1 point per ₹10 net)', () => {
    expect(
      pointsForOrder(
        { subtotalMinor: 48000, discountMinor: 0 },
        DEFAULT_LOYALTY_CONFIG,
      ),
    ).toBe(48);
  });
});

describe('redemptionFor (configurable redeem)', () => {
  it('prices a valid block: 100 points → ₹50 off', () => {
    expect(redemptionFor(100, 24000, cfg())).toEqual({
      ok: true,
      points: 100,
      discountMinor: 5000,
    });
  });

  it('prices multiple blocks', () => {
    expect(redemptionFor(300, 24000, cfg())).toEqual({
      ok: true,
      points: 300,
      discountMinor: 15000,
    });
  });

  it('rejects an amount that is not a whole block (37 pts)', () => {
    const r = redemptionFor(37, 24000, cfg());
    expect(r.ok).toBe(false);
  });

  it('rejects below the configured minimum', () => {
    const r = redemptionFor(100, 24000, cfg({ minimumRedeemPoints: 200 }));
    expect(r.ok).toBe(false);
  });

  it('rejects above the configured maximum', () => {
    const r = redemptionFor(600, 100000, cfg());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('at most');
  });

  it('refuses (never silently caps) a reward larger than the order', () => {
    // 100 pts = ₹50 discount on a ₹30 order → rejected, not capped to ₹30.
    const r = redemptionFor(100, 3000, cfg());
    expect(r.ok).toBe(false);
  });

  it('refuses redemption while loyalty is disabled', () => {
    expect(redemptionFor(100, 24000, cfg({ isEnabled: false })).ok).toBe(false);
  });

  it('allows any positive amount under the permissive default config', () => {
    // Default: block size 1, no floor/ceiling — mirrors pre-M13 behaviour.
    expect(redemptionFor(37, 24000, DEFAULT_LOYALTY_CONFIG)).toEqual({
      ok: true,
      points: 37,
      discountMinor: 3700,
    });
  });
});

describe('availableReward', () => {
  it('offers the smallest affordable block', () => {
    expect(availableReward(140, cfg())).toEqual({
      points: 100,
      discountMinor: 5000,
    });
  });

  it('is null when the balance is short of the minimum', () => {
    expect(availableReward(80, cfg())).toBeNull();
  });

  it('is null when loyalty is disabled', () => {
    expect(availableReward(500, cfg({ isEnabled: false }))).toBeNull();
  });
});

describe('validateConfig', () => {
  it('accepts a sane configuration', () => {
    expect(validateConfig(cfg())).toBeNull();
  });

  it.each([
    ['zero earn amount', cfg({ earnAmountMinor: 0 })],
    ['zero earn points', cfg({ earnPoints: 0 })],
    ['zero redeem points', cfg({ redeemPoints: 0 })],
    ['negative redeem amount', cfg({ redeemAmountMinor: -1 })],
    ['negative minimum', cfg({ minimumRedeemPoints: -1 })],
    ['negative maximum', cfg({ maximumRedeemPointsPerOrder: -1 })],
    // The spec's nonsensical case: ₹1 (100 paise) = 1,000,000 points.
    ['absurd earn rate', cfg({ earnAmountMinor: 100, earnPoints: 1_000_000 })],
    [
      'max below min',
      cfg({ minimumRedeemPoints: 300, maximumRedeemPointsPerOrder: 100 }),
    ],
    ['min not a multiple of the block', cfg({ minimumRedeemPoints: 150 })],
  ])('rejects %s', (_label, bad) => {
    expect(validateConfig(bad)).not.toBeNull();
  });
});
