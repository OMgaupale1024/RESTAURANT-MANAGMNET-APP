/**
 * Builds a daily sales CSV and hands it to the browser to download.
 *
 * Only dates and numbers are exported — deliberately no product names, which
 * would need CSV-injection escaping (a name starting with "=" is a formula in
 * Excel). The daily revenue series is what an accountant actually pastes into
 * their books. Money is paise/100 to two decimals: safe from float drift
 * because it starts from an integer.
 */
export function downloadSalesCsv(
  series: Array<{ date: string; orders: number; revenueMinor: number }>,
  from: string,
  to: string,
) {
  const header = 'Date,Orders,Revenue (INR)';
  const rows = series.map(
    (d) => `${d.date},${d.orders},${(d.revenueMinor / 100).toFixed(2)}`,
  );
  const csv = [header, ...rows].join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sales-${from}_to_${to}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
