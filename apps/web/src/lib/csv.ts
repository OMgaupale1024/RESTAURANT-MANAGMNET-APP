/**
 * CSV export helpers.
 *
 * Every cell goes through csvCell, which does two things:
 *   1. Quotes fields containing comma / quote / newline (RFC 4180), doubling
 *      any embedded quote.
 *   2. Neutralises CSV injection: a value starting with = + - @ (or a control
 *      char) is a formula in Excel/Sheets, so it is prefixed with a single
 *      quote. This is why product/customer names are safe to export here.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** paise → "123.45", safe from float drift because it starts from an integer. */
export function minorToCsv(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Builds a CSV string from a header row and cell rows. */
export function toCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

/** Hands a CSV string to the browser as a file download. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The daily sales CSV — dates and numbers only, the series an accountant
 * pastes into their books.
 */
export function downloadSalesCsv(
  series: Array<{ date: string; orders: number; revenueMinor: number }>,
  from: string,
  to: string,
) {
  const csv = toCsv(
    ['Date', 'Orders', 'Revenue (INR)'],
    series.map((d) => [d.date, d.orders, minorToCsv(d.revenueMinor)]),
  );
  downloadCsv(`sales-${from}_to_${to}.csv`, csv);
}
