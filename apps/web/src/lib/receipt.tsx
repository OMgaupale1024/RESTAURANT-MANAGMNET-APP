'use client';

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Order, RestaurantProfile } from '@/lib/api';
import { formatMinor } from '@/lib/money';

/**
 * Receipts — the paper the customer takes home, and the KOT the kitchen works
 * from.
 *
 * Printing renders into a hidden in-page area and calls window.print(); print
 * CSS (globals.css) hides the app and shows only the receipt. No popup, no
 * iframe, nothing for a popup blocker or the CSP to interfere with. The width
 * targets 80mm thermal paper (72mm printable) but prints fine on A4 too.
 *
 * Every line comes from stored data: the order's own snapshots and the saved
 * business profile. Absent profile fields are OMITTED, never invented.
 */

/* ------------------------------------------------------------------ print */

export function usePrintArea(): {
  printNode: (node: ReactNode) => void;
  portal: ReactNode;
} {
  const [content, setContent] = useState<ReactNode>(null);

  useEffect(() => {
    if (content === null) return;
    document.body.classList.add('printing');

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      document.body.classList.remove('printing');
      setContent(null);
    };
    window.addEventListener('afterprint', cleanup);

    // Two frames so the portal content is committed and styled before the
    // print dialog snapshots the page.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => window.print()),
    );

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('afterprint', cleanup);
      cleanup();
    };
  }, [content]);

  const printNode = useCallback((node: ReactNode) => setContent(node), []);

  const portal =
    content !== null && typeof document !== 'undefined'
      ? createPortal(<div id="print-area">{content}</div>, document.body)
      : null;

  return { printNode, portal };
}

/* ------------------------------------------------------------- templates */

function headerLines(profile: RestaurantProfile) {
  return (
    <header className="rc-center">
      <p className="rc-title">{profile.receiptHeader ?? profile.name}</p>
      {profile.address && <p>{profile.address}</p>}
      {profile.phone && <p>Ph: {profile.phone}</p>}
      {profile.gstin && <p>GSTIN: {profile.gstin}</p>}
      {profile.fssai && <p>FSSAI: {profile.fssai}</p>}
    </header>
  );
}

function when(order: Order): string {
  return new Date(order.placedAt ?? order.createdAt).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * GST lines grouped by rate, from the per-line snapshots. The CGST/SGST split
 * is the standard intra-state presentation: half each, with the odd paisa on
 * SGST so the two always sum to the stored tax — the printed bill can never
 * disagree with the database.
 */
function taxGroups(order: Order) {
  const byRate = new Map<number, { taxable: number; tax: number }>();
  for (const i of order.items) {
    const g = byRate.get(i.taxRateBp) ?? { taxable: 0, tax: 0 };
    g.taxable += i.lineTotalMinor;
    g.tax += i.taxMinor;
    byRate.set(i.taxRateBp, g);
  }
  return [...byRate.entries()]
    .filter(([rate, g]) => rate > 0 && g.tax > 0)
    .sort(([a], [b]) => a - b)
    .map(([rate, g]) => {
      const cgst = Math.floor(g.tax / 2);
      return {
        rate,
        taxable: g.taxable,
        cgst,
        sgst: g.tax - cgst,
        halfRate: rate / 200, // bp -> percent, halved
      };
    });
}

export function BillReceipt({
  order,
  profile,
}: {
  order: Order;
  profile: RestaurantProfile;
}) {
  const groups = taxGroups(order);
  const paid = order.payments.filter((p) => p.status === 'CAPTURED');
  return (
    <div className="rc">
      {headerLines(profile)}
      <div className="rc-rule" />
      <p>
        Bill #{order.orderNumber} · {when(order)}
      </p>
      {order.customer && (
        <p>
          {order.customer.name} · {order.customer.phone}
        </p>
      )}
      <div className="rc-rule" />
      <table className="rc-items">
        <tbody>
          {order.items.map((i) => (
            <tr key={i.id}>
              <td className="rc-qty">{i.quantity}×</td>
              <td>
                {i.nameSnapshot}
                {i.notes && <span className="rc-note"> — {i.notes}</span>}
              </td>
              <td className="rc-amt">{formatMinor(i.lineTotalMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rc-rule" />
      <table className="rc-totals">
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="rc-amt">{formatMinor(order.subtotalMinor)}</td>
          </tr>
          {order.discountMinor > 0 && (
            <tr>
              <td>Discount</td>
              <td className="rc-amt">−{formatMinor(order.discountMinor)}</td>
            </tr>
          )}
          {groups.map((g) => (
            <Fragment key={g.rate}>
              <tr>
                <td>CGST @{g.halfRate}%</td>
                <td className="rc-amt">{formatMinor(g.cgst)}</td>
              </tr>
              <tr>
                <td>SGST @{g.halfRate}%</td>
                <td className="rc-amt">{formatMinor(g.sgst)}</td>
              </tr>
            </Fragment>
          ))}
          <tr className="rc-grand">
            <td>TOTAL</td>
            <td className="rc-amt">{formatMinor(order.totalMinor)}</td>
          </tr>
          {paid.map((p) => (
            <tr key={p.id}>
              <td>Paid — {p.method}</td>
              <td className="rc-amt">{formatMinor(p.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rc-rule" />
      <footer className="rc-center">
        {profile.receiptFooter && <p>{profile.receiptFooter}</p>}
        <p>Order #{order.orderNumber}</p>
      </footer>
    </div>
  );
}

/** Kitchen Order Ticket: what to cook, big; never a price. */
export function KotTicket({
  order,
  profile,
}: {
  order: Order;
  profile: RestaurantProfile | null;
}) {
  return (
    <div className="rc rc-kot">
      <header className="rc-center">
        <p className="rc-title">KOT #{order.orderNumber}</p>
        {profile && <p>{profile.name}</p>}
        <p>{when(order)}</p>
      </header>
      <div className="rc-rule" />
      <ul className="rc-kot-items">
        {order.items.map((i) => (
          <li key={i.id}>
            <span className="rc-qty">{i.quantity}×</span> {i.nameSnapshot}
            {i.notes && <p className="rc-note">→ {i.notes}</p>}
          </li>
        ))}
      </ul>
      {order.notes && (
        <>
          <div className="rc-rule" />
          <p className="rc-kot-note">NOTE: {order.notes}</p>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- share */

/** Plain-text bill for WhatsApp — the way small restaurants actually share. */
export function buildShareText(order: Order, profile: RestaurantProfile): string {
  const lines: string[] = [
    profile.receiptHeader ?? profile.name,
    `Bill #${order.orderNumber} — ${when(order)}`,
    '',
    ...order.items.map(
      (i) => `${i.quantity} × ${i.nameSnapshot} — ${formatMinor(i.lineTotalMinor)}`,
    ),
    '',
    `Subtotal: ${formatMinor(order.subtotalMinor)}`,
  ];
  if (order.discountMinor > 0) {
    lines.push(`Discount: −${formatMinor(order.discountMinor)}`);
  }
  lines.push(`GST: ${formatMinor(order.taxMinor)}`);
  lines.push(`Total: ${formatMinor(order.totalMinor)}`);
  const paid = order.payments.find((p) => p.status === 'CAPTURED');
  if (paid) lines.push(`Paid by ${paid.method}`);
  if (profile.gstin) lines.push(`GSTIN: ${profile.gstin}`);
  if (profile.receiptFooter) lines.push('', profile.receiptFooter);
  return lines.join('\n');
}

/** wa.me link — to the customer's number when the order has one. */
export function waShareUrl(text: string, phone?: string | null): string {
  const target = phone ? phone.replace(/[^0-9]/g, '') : '';
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}
