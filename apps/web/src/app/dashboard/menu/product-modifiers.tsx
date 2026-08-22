'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import {
  ApiRequestError,
  createModifierGroup,
  createModifierOption,
  deleteModifierGroup,
  deleteModifierOption,
  listModifierGroups,
  updateModifierGroup,
  updateModifierOption,
  type ModifierGroupAdmin,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { formatMinor, parseRupeesToMinor } from '@/lib/money';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';

/**
 * Owner/manager modifier editor for one product. Self-contained (owns its own
 * fetch + mutations + toasts) so the Menu edit sheet just drops it in. Every
 * write hits a product.manage endpoint; the server is the authority on rules
 * and pricing — this is the friendly front end.
 *
 * The UI models the common cases as "Required" + "Max choices" (min = 0 or 1);
 * the API supports any min/max if a rarer rule is ever needed.
 */

function ruleText(g: ModifierGroupAdmin): string {
  const required = g.minSelect >= 1;
  if (g.maxSelect === 1) return required ? 'Required · choose 1' : 'Optional · choose 1';
  return `${required ? 'Required' : 'Optional'} · up to ${g.maxSelect}`;
}

export function ProductModifiers({ productId }: { productId: string }) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const [groups, setGroups] = useState<ModifierGroupAdmin[] | null>(null);

  const reload = useCallback(() => {
    if (!accessToken) return;
    listModifierGroups(accessToken, onNewToken, productId)
      .then(setGroups)
      .catch((e) =>
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not load modifiers',
          variant: 'danger',
        }),
      );
  }, [accessToken, onNewToken, productId, toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  function fail(e: unknown) {
    toast({
      title: e instanceof ApiRequestError ? e.message : 'Could not save',
      variant: 'danger',
    });
  }

  async function addGroup(name: string, required: boolean, max: number) {
    if (!accessToken) return;
    try {
      await createModifierGroup(accessToken, onNewToken, productId, {
        name,
        minSelect: required ? 1 : 0,
        maxSelect: max,
        sortOrder: groups?.length ?? 0,
      });
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function patchGroup(
    id: string,
    body: Parameters<typeof updateModifierGroup>[3],
  ) {
    if (!accessToken) return;
    try {
      await updateModifierGroup(accessToken, onNewToken, id, body);
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function removeGroup(id: string, name: string) {
    if (!accessToken) return;
    try {
      await deleteModifierGroup(accessToken, onNewToken, id);
      toast({ title: `Removed ${name}`, variant: 'success' });
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function move(index: number, dir: -1 | 1) {
    if (!groups) return;
    const a = groups[index];
    const b = groups[index + dir];
    if (!a || !b || !accessToken) return;
    try {
      await updateModifierGroup(accessToken, onNewToken, a.id, { sortOrder: b.sortOrder });
      await updateModifierGroup(accessToken, onNewToken, b.id, { sortOrder: a.sortOrder });
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function addOption(groupId: string, name: string, priceMinor: number) {
    if (!accessToken) return;
    try {
      await createModifierOption(accessToken, onNewToken, groupId, {
        name,
        priceAdjustMinor: priceMinor,
      });
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function patchOption(
    id: string,
    body: Parameters<typeof updateModifierOption>[3],
  ) {
    if (!accessToken) return;
    try {
      await updateModifierOption(accessToken, onNewToken, id, body);
      reload();
    } catch (e) {
      fail(e);
    }
  }

  async function removeOption(id: string) {
    if (!accessToken) return;
    try {
      await deleteModifierOption(accessToken, onNewToken, id);
      reload();
    } catch (e) {
      fail(e);
    }
  }

  if (groups === null) {
    return <Skeleton className="h-24" />;
  }

  return (
    <div className="space-y-3">
      {groups.length === 0 && (
        <p className="text-[13px] text-ink-3">
          No modifiers yet. Add a group like “Style” or “Add-ons”.
        </p>
      )}

      {groups.map((g, i) => (
        <GroupCard
          key={g.id}
          group={g}
          isFirst={i === 0}
          isLast={i === groups.length - 1}
          onMoveUp={() => move(i, -1)}
          onMoveDown={() => move(i, 1)}
          onPatch={(body) => patchGroup(g.id, body)}
          onDelete={() => removeGroup(g.id, g.name)}
          onAddOption={(name, price) => addOption(g.id, name, price)}
          onPatchOption={patchOption}
          onDeleteOption={removeOption}
        />
      ))}

      <AddGroupForm onAdd={addGroup} />
    </div>
  );
}

function GroupCard({
  group,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onPatch,
  onDelete,
  onAddOption,
  onPatchOption,
  onDeleteOption,
}: {
  group: ModifierGroupAdmin;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onPatch: (body: Parameters<typeof updateModifierGroup>[3]) => void;
  onDelete: () => void;
  onAddOption: (name: string, priceMinor: number) => void;
  onPatchOption: (id: string, body: Parameters<typeof updateModifierOption>[3]) => void;
  onDeleteOption: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-line p-3',
        !group.isActive && 'opacity-60',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{group.name}</p>
          <p className="text-[12px] text-ink-3">{ruleText(group)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Move up"
            disabled={isFirst}
            onClick={onMoveUp}
            className="w-7 px-0"
          >
            <ChevronUp aria-hidden className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Move down"
            disabled={isLast}
            onClick={onMoveDown}
            className="w-7 px-0"
          >
            <ChevronDown aria-hidden className="size-4" />
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onPatch({ isActive: !group.isActive })}
          >
            {group.isActive ? 'Hide' : 'Show'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Delete ${group.name}`}
            onClick={onDelete}
            className="w-7 px-0 text-danger-text"
          >
            <Trash2 aria-hidden className="size-4" />
          </Button>
        </div>
      </div>

      <ul className="mt-2 space-y-1">
        {group.options.map((o) => (
          <li
            key={o.id}
            className={cn(
              'flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px]',
              !o.isActive && 'opacity-60',
            )}
          >
            <span className="min-w-0 truncate">
              {o.name}
              {!o.isActive && <Badge className="ml-2">Hidden</Badge>}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <span className="tabular-nums text-ink-2">
                {o.priceAdjustMinor > 0 ? `+${formatMinor(o.priceAdjustMinor)}` : '—'}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onPatchOption(o.id, { isActive: !o.isActive })}
              >
                {o.isActive ? 'Hide' : 'Show'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${o.name}`}
                onClick={() => onDeleteOption(o.id)}
                className="w-7 px-0 text-danger-text"
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <AddOptionForm onAdd={onAddOption} />
    </div>
  );
}

function AddOptionForm({
  onAdd,
}: {
  onAdd: (name: string, priceMinor: number) => void;
}) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const minor = price.trim() ? parseRupeesToMinor(price) : 0;
    if (minor === null || minor < 0) return;
    onAdd(trimmed, minor);
    setName('');
    setPrice('');
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Option name"
        aria-label="Option name"
        className="h-8 flex-1 text-[13px]"
      />
      <Input
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="+₹0"
        aria-label="Price adjustment in rupees"
        className="h-8 w-20 text-[13px]"
      />
      <Button variant="secondary" size="sm" onClick={submit} disabled={!name.trim()}>
        <Plus aria-hidden className="size-3.5" />
        Add
      </Button>
    </div>
  );
}

function AddGroupForm({
  onAdd,
}: {
  onAdd: (name: string, required: boolean, max: number) => void;
}) {
  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [max, setMax] = useState('1');

  function submit() {
    const trimmed = name.trim();
    const maxNum = parseInt(max, 10);
    if (!trimmed || !Number.isFinite(maxNum) || maxNum < 1) return;
    onAdd(trimmed, required, maxNum);
    setName('');
    setRequired(true);
    setMax('1');
  }

  return (
    <div className="rounded-xl border border-dashed border-line p-3">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="New group (e.g. Style, Add-ons)"
          aria-label="New modifier group name"
          className="h-8 flex-1 text-[13px]"
        />
        <Button variant="secondary" size="sm" onClick={submit} disabled={!name.trim()}>
          <Plus aria-hidden className="size-3.5" />
          Add group
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="size-4 accent-[var(--brand)]"
          />
          Required
        </label>
        <label className="flex items-center gap-1.5">
          Max choices
          <Input
            inputMode="numeric"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            aria-label="Maximum choices"
            className="h-8 w-14 text-[13px]"
          />
        </label>
      </div>
    </div>
  );
}
