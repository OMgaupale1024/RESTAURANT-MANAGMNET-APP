import type { AnalyticsOverview } from './api';

/**
 * Date and series helpers shared by the dashboard, Analytics and Reports.
 * All business days are IST days — same convention as the server aggregation.
 */

const IST = 'Asia/Kolkata';

/** IST calendar day (YYYY-MM-DD) of an instant. */
export function istDay(d: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date(d));
}

/** Local calendar day as YYYY-MM-DD, for date inputs. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Pure date-string arithmetic — no timezone involved. */
export function addDays(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Inclusive count of calendar days from one YYYY-MM-DD to another. */
export function daysBetween(fromDay: string, toDay: string): number {
  return (
    Math.round(
      (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000,
    ) + 1
  );
}

/**
 * The API's revenueSeries is sparse — only days that had orders. Fill the
 * range window with zero days so day N-1 really is the previous day, the
 * x-axis spacing is honest, and a day-one restaurant still gets a drawable
 * series.
 */
export function fillSeries<
  T extends Pick<AnalyticsOverview, 'from' | 'to' | 'revenueSeries'>,
>(o: T): T {
  const byDate = new Map(o.revenueSeries.map((d) => [d.date, d]));
  const series: AnalyticsOverview['revenueSeries'] = [];
  for (let t = new Date(o.from).getTime(); t <= new Date(o.to).getTime(); t += 86_400_000) {
    const date = istDay(new Date(t));
    series.push(byDate.get(date) ?? { date, revenueMinor: 0, orders: 0 });
  }
  return { ...o, revenueSeries: series };
}

/** Fractional change vs a previous value; null when not computable. */
export function pctDelta(nowV: number, prevV: number): number | null {
  if (prevV === 0) return null;
  return (nowV - prevV) / prevV;
}

/** 24h hour index → compact IST clock label. */
export function hourLabel(h: number): string {
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
}
