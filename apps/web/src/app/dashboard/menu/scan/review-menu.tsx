'use client';

import { useState } from 'react';
import { AlertTriangle, FolderPlus, Plus, Trash2 } from 'lucide-react';
import type { ImportAction, ReviewCategory, ReviewItem, ReviewMenu } from '@/lib/api';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';

/**
 * The review editor (spec §7): every field editable, low-confidence flagged
 * (§8), duplicates / price changes / new items badged (§9–§11), items
 * selectable, addable, deletable, and movable between categories.
 *
 * Controlled: it owns no menu state, only per-price-input text (so typing "6."
 * is not reformatted mid-keystroke). The parent holds the ReviewMenu.
 */

const LOW_CONFIDENCE = 0.7;

function defaultAction(kind: ReviewItem['match']['kind']): ImportAction {
  return kind === 'new' ? 'create' : kind === 'price_change' ? 'update' : 'skip';
}

let idSeq = 0;
const newId = () => `n${Date.now()}_${idSeq++}`;

export function ReviewMenuEditor({
  menu,
  onChange,
}: {
  menu: ReviewMenu;
  onChange: (m: ReviewMenu) => void;
}) {
  const set = (categories: ReviewCategory[]) => onChange({ categories });

  const patchItem = (ci: number, id: string, patch: Partial<ReviewItem>) =>
    set(
      menu.categories.map((c, i) =>
        i !== ci
          ? c
          : {
              ...c,
              items: c.items.map((it) =>
                it.id === id ? { ...it, ...patch } : it,
              ),
            },
      ),
    );

  const toggleSelect = (ci: number, it: ReviewItem) =>
    patchItem(ci, it.id, {
      action: it.action === 'skip' ? defaultAction(it.match.kind) : 'skip',
    });

  const removeItem = (ci: number, id: string) =>
    set(
      menu.categories.map((c, i) =>
        i !== ci ? c : { ...c, items: c.items.filter((it) => it.id !== id) },
      ),
    );

  const addItem = (ci: number) =>
    set(
      menu.categories.map((c, i) =>
        i !== ci
          ? c
          : {
              ...c,
              items: [
                ...c.items,
                {
                  id: newId(),
                  name: '',
                  priceMinor: null,
                  confidence: 1,
                  action: 'create',
                  match: { kind: 'new' },
                },
              ],
            },
      ),
    );

  const renameCategory = (ci: number, name: string) =>
    set(menu.categories.map((c, i) => (i !== ci ? c : { ...c, name })));

  const removeCategory = (ci: number) =>
    set(menu.categories.filter((_, i) => i !== ci));

  const addCategory = () =>
    set([...menu.categories, { name: 'New category', items: [] }]);

  const moveItem = (fromCi: number, id: string, toCi: number) => {
    if (fromCi === toCi) return;
    const item = menu.categories[fromCi]?.items.find((it) => it.id === id);
    if (!item) return;
    set(
      menu.categories.map((c, i) => {
        if (i === fromCi)
          return { ...c, items: c.items.filter((it) => it.id !== id) };
        if (i === toCi) return { ...c, items: [...c.items, item] };
        return c;
      }),
    );
  };

  const all = menu.categories.flatMap((c) => c.items);
  const nw = all.filter((i) => i.match.kind === 'new').length;
  const price = all.filter((i) => i.match.kind === 'price_change').length;
  const dup = all.filter((i) => i.match.kind === 'duplicate').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-2">
        {nw > 0 && (
          <span className="text-success-text">
            {nw} new item{nw === 1 ? '' : 's'}
          </span>
        )}
        {price > 0 && (
          <span className="text-warning-text">
            {price} price change{price === 1 ? '' : 's'}
          </span>
        )}
        {dup > 0 && (
          <span>
            {dup} already on the menu
          </span>
        )}
      </div>

      <p className="rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-3">
        Saved to your POS: item name, price and category. Detected portion and
        description are shown to help you check the reading.
      </p>

      {menu.categories.map((cat, ci) => (
        <div
          key={ci}
          className="rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Input
              value={cat.name}
              onChange={(e) => renameCategory(ci, e.target.value)}
              aria-label="Category name"
              maxLength={60}
              className="h-8 max-w-56 flex-1 text-[13px] font-medium"
            />
            <span className="text-[11px] text-ink-3 tabular-nums">
              {cat.items.length} item{cat.items.length === 1 ? '' : 's'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete category ${cat.name}`}
              onClick={() => removeCategory(ci)}
              className="w-7 px-0 text-ink-3 hover:text-danger"
            >
              <Trash2 aria-hidden className="size-3.5" />
            </Button>
          </div>

          <div className="divide-y divide-line/60">
            {cat.items.map((it) => {
              const selected = it.action !== 'skip';
              const low = it.confidence < LOW_CONFIDENCE;
              const priceMissing = selected && it.priceMinor === null;
              return (
                <div
                  key={it.id}
                  className={cn(
                    'flex flex-wrap items-center gap-2 px-3 py-2',
                    !selected && 'opacity-55',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => toggleSelect(ci, it)}
                    aria-label={`Include ${it.name || 'this item'}`}
                    className="size-4 shrink-0 accent-[var(--color-brand)]"
                  />
                  <Input
                    value={it.name}
                    onChange={(e) => patchItem(ci, it.id, { name: e.target.value })}
                    placeholder="Item name"
                    maxLength={120}
                    className="h-8 min-w-40 flex-1 text-[13px]"
                  />
                  {it.quantity && (
                    <span className="text-[11px] whitespace-nowrap text-ink-3">
                      {it.quantity}
                    </span>
                  )}
                  <PriceInput
                    minor={it.priceMinor}
                    invalid={priceMissing}
                    onChange={(m) => patchItem(ci, it.id, { priceMinor: m })}
                  />

                  {it.match.kind === 'new' && <Badge variant="success">New</Badge>}
                  {it.match.kind === 'duplicate' && (
                    <Badge variant="neutral">On menu</Badge>
                  )}
                  {it.match.kind === 'price_change' &&
                    it.match.existingPriceMinor !== undefined && (
                      <Badge variant="warning">
                        {formatMinor(it.match.existingPriceMinor)} →{' '}
                        {it.priceMinor !== null ? formatMinor(it.priceMinor) : '—'}
                      </Badge>
                    )}
                  {low && (
                    <Badge variant="warning">
                      <AlertTriangle aria-hidden className="size-3" />
                      Verify
                    </Badge>
                  )}
                  {priceMissing && (
                    <span className="text-[11px] text-danger-text">
                      Needs a price
                    </span>
                  )}

                  <Select
                    value={String(ci)}
                    onChange={(e) => moveItem(ci, it.id, Number(e.target.value))}
                    aria-label="Move to category"
                    className="h-8 w-28 text-[12px]"
                  >
                    {menu.categories.map((c, i) => (
                      <option key={i} value={i}>
                        {c.name || 'Untitled'}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${it.name || 'item'}`}
                    onClick={() => removeItem(ci, it.id)}
                    className="w-7 px-0 text-ink-3 hover:text-danger"
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                  </Button>

                  {it.description && (
                    <p className="w-full pl-6 text-[11px] text-ink-3">
                      {it.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-line px-3 py-2">
            <Button size="sm" variant="ghost" onClick={() => addItem(ci)}>
              <Plus aria-hidden className="size-3.5" />
              Add item
            </Button>
          </div>
        </div>
      ))}

      <Button variant="secondary" size="sm" onClick={addCategory}>
        <FolderPlus aria-hidden className="size-4" />
        Add category
      </Button>
    </div>
  );
}

/** Rupee price input with its own text state, so mid-typing is not reformatted. */
function PriceInput({
  minor,
  onChange,
  invalid,
}: {
  minor: number | null;
  onChange: (m: number | null) => void;
  invalid?: boolean;
}) {
  const [text, setText] = useState(minor === null ? '' : String(minor / 100));
  return (
    <div className="relative shrink-0">
      <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[12px] text-ink-3">
        ₹
      </span>
      <Input
        inputMode="decimal"
        value={text}
        error={invalid}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          onChange(v.trim() === '' ? null : parseRupeesToMinor(v));
        }}
        placeholder="0"
        aria-label="Price in rupees"
        className="h-8 w-24 pl-5 text-[13px] tabular-nums"
      />
    </div>
  );
}
