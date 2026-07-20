/**
 * The "today" window must be an IST day, not the host's day.
 *
 * The bug this pins: `from.setHours(0,0,0,0)` resolved in the Node process's
 * timezone, so on a UTC host (every target in DEPLOYMENT.md) "today" started at
 * 05:30 IST and dropped the small hours of trade. A revenue figure that changes
 * with the deploy host is the defect; these assertions fail if it comes back.
 */
import { istStartOfDay } from './analytics.service';

describe('istStartOfDay', () => {
  const withTZ = <T>(tz: string, fn: () => T): T => {
    const original = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = original;
    }
  };

  it('anchors to IST midnight (18:30Z the previous day)', () => {
    // 07:46 IST on 20 Jul.
    const at = new Date('2026-07-20T02:16:00.000Z');
    expect(istStartOfDay(at).toISOString()).toBe('2026-07-19T18:30:00.000Z');
  });

  it('keeps an early-morning IST instant on the same IST day', () => {
    // 02:00 IST on 20 Jul — the case the old code pushed onto the PREVIOUS day,
    // making "today" span roughly 21 hours of yesterday.
    const at = new Date('2026-07-19T20:30:00.000Z');
    expect(istStartOfDay(at).toISOString()).toBe('2026-07-19T18:30:00.000Z');
  });

  it('returns the same instant whatever timezone the host runs in', () => {
    const at = new Date('2026-07-20T02:16:00.000Z');
    const utc = withTZ('UTC', () => istStartOfDay(at).toISOString());
    const ist = withTZ('Asia/Kolkata', () => istStartOfDay(at).toISOString());
    const nyc = withTZ('America/New_York', () =>
      istStartOfDay(at).toISOString(),
    );

    expect(utc).toBe('2026-07-19T18:30:00.000Z');
    expect(ist).toBe(utc);
    expect(nyc).toBe(utc);
  });

  /**
   * The business property: whatever instant goes in, the instant that comes
   * back IS midnight in TZ — across seasons and across the boundary itself.
   *
   * Note what this does NOT prove: while TZ is Asia/Kolkata a hardcoded
   * "+05:30" would satisfy it too. The offset being derived from TZ rather
   * than written down is enforced structurally — there is no offset literal in
   * the source — not by this assertion.
   */
  it('returns an instant that reads as exactly midnight in TZ', () => {
    const wallClock = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(d);

    for (const iso of [
      '2026-07-20T02:16:00.000Z', // mid-morning IST
      '2026-07-19T20:30:00.000Z', // 02:00 IST — the dropped window
      '2026-07-19T18:30:00.000Z', // exactly midnight IST
      '2026-01-15T12:00:00.000Z', // a different season
    ]) {
      expect(wallClock(istStartOfDay(new Date(iso)))).toMatch(/, 00:00:00$/);
    }
  });

  it('rolls to the next IST day exactly at the boundary', () => {
    // 23:59:59 IST on 19 Jul, then 00:00:00 IST on 20 Jul.
    expect(
      istStartOfDay(new Date('2026-07-19T18:29:59.999Z')).toISOString(),
    ).toBe('2026-07-18T18:30:00.000Z');
    expect(
      istStartOfDay(new Date('2026-07-19T18:30:00.000Z')).toISOString(),
    ).toBe('2026-07-19T18:30:00.000Z');
  });
});
