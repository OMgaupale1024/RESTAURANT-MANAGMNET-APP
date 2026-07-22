'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, MailPlus, PencilLine, UsersRound } from 'lucide-react';
import {
  ApiRequestError,
  clockMember,
  clockSelf,
  correctAttendance,
  createInvite,
  getMe,
  getTimesheet,
  listInvites,
  listStaff,
  revokeInvite,
  updateMember,
  type PendingInvite,
  type StaffMember,
  type TimesheetEntry,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { downloadCsv, toCsv } from '@/lib/csv';
import { timeShort } from '../orders/order-detail';

/**
 * Timesheet → CSV, one row per staff member: total hours plus paired sessions.
 * The payroll input a manager actually hands to an accountant. Hours are
 * decimal (minutes/60) so a spreadsheet can multiply by a wage rate.
 */
function exportTimesheetCsv(sheet: TimesheetEntry[], from: string, to: string) {
  const csv = toCsv(
    ['Staff', 'Role', 'Sessions', 'Total hours', 'Open session'],
    sheet.map((s) => [
      s.name,
      s.role,
      s.sessions.length,
      (s.totalMinutes / 60).toFixed(2),
      s.openSession ? 'yes' : '',
    ]),
  );
  downloadCsv(`timesheet-${from}_to_${to}.csv`, csv);
}
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Modal } from '@/components/ui/modal';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Sheet } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * Staff — the team and its append-only attendance ledger. On-shift is always
 * DERIVED from the latest event; hours come from the server's session pairing
 * (an open session is reported, never guessed closed).
 */

const TABS = [
  { key: 'TEAM', label: 'Team' },
  { key: 'ATTENDANCE', label: 'Attendance' },
] as const;

const ROLES = ['MANAGER', 'CASHIER', 'KITCHEN'] as const;

const fmtMinutes = (m: number) =>
  m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim();

const isoDay = (d: Date) => d.toLocaleDateString('en-CA');
const dayStartIso = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const dayEndIso = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();

export function StaffClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('TEAM');
  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [today, setToday] = useState<Map<string, TimesheetEntry>>(new Map());
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    Promise.all([
      listStaff(accessToken, onNewToken),
      // A cashier can read the team but not the invites; a 403 here is
      // expected, not an error worth showing.
      listInvites(accessToken, onNewToken).catch(() => [] as PendingInvite[]),
      getTimesheet(accessToken, onNewToken, { from: dayStartIso(isoDay(new Date())) }).catch(
        () => [] as TimesheetEntry[],
      ),
      getMe(accessToken).catch(() => null),
    ])
      .then(([team, pending, sheet, me]) => {
        if (cancelled) return;
        setMembers(team);
        setInvites(pending);
        setToday(new Map(sheet.map((s) => [s.membershipId, s])));
        if (me) setMyUserId(me.user.id);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load staff',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, reloadKey, toast]);

  const clock = useCallback(
    async (m: StaffMember) => {
      const token = tokenRef.current;
      if (!token) return;
      const type = m.onShift ? 'CLOCK_OUT' : 'CLOCK_IN';
      try {
        // Your own clock goes through the self route (no permission needed);
        // clocking others requires attendance.manage, which the server checks.
        if (m.user.id === myUserId) await clockSelf(token, onNewToken, type);
        else await clockMember(token, onNewToken, m.id, type);
        toast({
          title: `${m.user.name} clocked ${type === 'CLOCK_IN' ? 'in' : 'out'}`,
          variant: 'success',
        });
        reload();
      } catch (e) {
        toast({
          title: e instanceof ApiRequestError ? e.message : 'Could not clock',
          variant: 'danger',
        });
      }
    },
    [myUserId, onNewToken, reload, toast],
  );

  const loading = members === null;
  const team = members ?? [];
  const selected = team.find((m) => m.id === selectedId) ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Staff</h1>
        <div className="flex items-center gap-3">
          <Segmented options={TABS} value={tab} onChange={setTab} />
          <Button variant="primary" onClick={() => setInviting(true)}>
            <MailPlus aria-hidden className="size-4" />
            Invite
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2" aria-label="Loading staff">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : tab === 'TEAM' ? (
        <TeamTab
          team={team}
          invites={invites}
          today={today}
          myUserId={myUserId}
          selectedId={selectedId}
          onOpen={setSelectedId}
          onClock={clock}
          onRevoked={reload}
        />
      ) : (
        <AttendanceTab
          team={team}
          myUserId={myUserId}
          onClock={clock}
          onCorrected={reload}
        />
      )}

      <Sheet
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected?.user.name ?? 'Staff member'}
      >
        {selected && (
          <MemberSheet
            member={selected}
            isSelf={selected.user.id === myUserId}
            onChanged={reload}
            onClock={clock}
          />
        )}
      </Sheet>

      <InviteModal
        open={inviting}
        onClose={() => setInviting(false)}
        onCreated={reload}
      />
    </div>
  );
}

function statusBadges(m: StaffMember) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {!m.isActive ? (
        <Badge>Inactive</Badge>
      ) : m.onShift ? (
        <Badge variant="success">On shift</Badge>
      ) : (
        <Badge>Off</Badge>
      )}
    </span>
  );
}

function TeamTab({
  team,
  invites,
  today,
  myUserId,
  selectedId,
  onOpen,
  onClock,
  onRevoked,
}: {
  team: StaffMember[];
  invites: PendingInvite[];
  today: Map<string, TimesheetEntry>;
  myUserId: string | null;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onClock: (m: StaffMember) => Promise<void>;
  onRevoked: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  return (
    <>
      <div className="mt-4 rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
        <Table containerClassName="max-h-[calc(100dvh-16rem)] overflow-y-auto rounded-xl">
          <thead>
            <tr>
              <Th>Staff</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th numeric className="hidden sm:table-cell">
                Today
              </Th>
              <Th className="w-px" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {team.map((m) => {
              const sheet = today.get(m.id);
              return (
                <Tr
                  key={m.id}
                  onClick={() => onOpen(m.id)}
                  aria-selected={selectedId === m.id}
                  className={cn('animate-fade-up', selectedId === m.id && 'bg-surface-2')}
                >
                  <Td>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(m.id);
                      }}
                      className="rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                    >
                      <span className="block font-medium">
                        {m.user.name}
                        {m.user.id === myUserId && (
                          <span className="ml-1.5 text-[11px] font-normal text-ink-3">you</span>
                        )}
                      </span>
                      <span className="block text-[12px] text-ink-3">{m.user.email}</span>
                    </button>
                  </Td>
                  <Td>
                    <Badge variant="info">{m.role.name}</Badge>
                  </Td>
                  <Td>{statusBadges(m)}</Td>
                  <Td numeric className="hidden text-ink-2 tabular-nums sm:table-cell">
                    {sheet && (sheet.totalMinutes > 0 || sheet.openSession) ? (
                      <>
                        {fmtMinutes(sheet.totalMinutes)}
                        {sheet.openSession && (
                          <span className="ml-1.5 text-[11px] text-success-text">on shift</span>
                        )}
                      </>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </Td>
                  <Td className="py-1.5 text-right">
                    {m.isActive && (
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void onClock(m);
                        }}
                      >
                        {m.onShift ? 'Clock out' : 'Clock in'}
                      </Button>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </div>

      {invites.length > 0 && (
        <section className="mt-6">
          <h2 className="text-label mb-2">Pending invites</h2>
          <ul className="space-y-2">
            {invites.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-2.5 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px]"
              >
                <span className="min-w-0 truncate font-medium">{i.email}</span>
                <Badge variant="info">{i.role.name}</Badge>
                <span className="text-[12px] text-ink-3">
                  expires {timeShort(i.expiresAt)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-danger-text"
                  onClick={() => {
                    if (!accessToken) return;
                    revokeInvite(accessToken, onNewToken, i.id)
                      .then(() => {
                        toast({ title: 'Invite revoked', variant: 'success' });
                        onRevoked();
                      })
                      .catch((e: unknown) =>
                        toast({
                          title: e instanceof ApiRequestError ? e.message : 'Could not revoke',
                          variant: 'danger',
                        }),
                      );
                  }}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function AttendanceTab({
  team,
  myUserId,
  onClock,
  onCorrected,
}: {
  team: StaffMember[];
  myUserId: string | null;
  onClock: (m: StaffMember) => Promise<void>;
  onCorrected: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [sheet, setSheet] = useState<TimesheetEntry[] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!accessToken || from > to) return;
    let cancelled = false;
    getTimesheet(accessToken, onNewToken, {
      from: dayStartIso(from),
      to: dayEndIso(to),
    })
      .then((rows) => {
        if (!cancelled) setSheet(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          toast({
            title: e instanceof ApiRequestError ? e.message : 'Could not load timesheet',
            variant: 'danger',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, from, to, toast, reloadKey]);

  const onShift = team.filter((m) => m.onShift);
  const me = team.find((m) => m.user.id === myUserId) ?? null;

  return (
    <div className="mt-4 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        {me && me.isActive && (
          <Button variant="primary" size="lg" onClick={() => void onClock(me)}>
            {me.onShift ? 'Clock out' : 'Clock in'}
          </Button>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[12px] text-ink-3">On shift now:</span>
          {onShift.length === 0 ? (
            <span className="text-[13px] text-ink-2">nobody</span>
          ) : (
            onShift.map((m) => (
              <Badge key={m.id} variant="success">
                {m.user.name}
              </Badge>
            ))
          )}
        </div>
      </div>

      <section>
        <div className="mb-2 flex flex-wrap items-end gap-2">
          <h2 className="text-label mr-auto">Timesheet</h2>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-40" />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-40" />
          </Field>
          <Button variant="secondary" onClick={() => setCorrecting(true)}>
            <PencilLine aria-hidden className="size-4" />
            Correction
          </Button>
          <Button
            variant="secondary"
            disabled={!sheet || sheet.every((s) => s.sessions.length === 0)}
            onClick={() => sheet && exportTimesheetCsv(sheet, from, to)}
          >
            <Download aria-hidden className="size-4" />
            Export CSV
          </Button>
        </div>

        <CorrectionModal
          open={correcting}
          onClose={() => setCorrecting(false)}
          team={team}
          onDone={() => {
            setCorrecting(false);
            setReloadKey((k) => k + 1);
            onCorrected();
          }}
        />

        <div className="rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
          {sheet === null ? (
            <div className="space-y-2 p-4" aria-label="Loading timesheet">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : sheet.every((s) => s.sessions.length === 0) ? (
            <EmptyState
              icon={UsersRound}
              title="No attendance in this range"
              body="Clock-ins and clock-outs recorded in the range appear here, paired into sessions."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Staff</Th>
                  <Th numeric>Sessions</Th>
                  <Th numeric>Hours</Th>
                  <Th>Note</Th>
                </tr>
              </thead>
              <tbody>
                {sheet
                  .filter((s) => s.sessions.length > 0)
                  .map((s) => (
                    <Tr key={s.membershipId}>
                      <Td className="font-medium">{s.name}</Td>
                      <Td numeric>{s.sessions.length}</Td>
                      <Td numeric className="font-medium">
                        {fmtMinutes(s.totalMinutes)}
                      </Td>
                      <Td className="text-ink-2">
                        {s.openSession ? (
                          // An unpaired clock-in is reported, never guessed
                          // closed — a guessed end time is a guessed wage.
                          <Badge variant="warning">open session</Badge>
                        ) : (
                          '—'
                        )}
                      </Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * A manager records a backdated clock event to fix a forgotten in/out. The
 * ledger is append-only, so this appends a corrected event (recordedBy marks
 * it manager-entered) rather than editing history — the API enforces the same.
 */
function CorrectionModal({
  open,
  onClose,
  team,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  team: StaffMember[];
  onDone: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const active = team.filter((m) => m.isActive);
  const [membershipId, setMembershipId] = useState('');
  const [type, setType] = useState<'CLOCK_IN' | 'CLOCK_OUT'>('CLOCK_OUT');
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = membershipId !== '' && when !== '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !valid || busy) return;
    // datetime-local is wall time; toISOString sends the instant.
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) {
      toast({ title: 'Pick a valid date and time', variant: 'warning' });
      return;
    }
    setBusy(true);
    try {
      await correctAttendance(accessToken, onNewToken, membershipId, {
        type,
        at: at.toISOString(),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast({ title: 'Correction recorded', variant: 'success' });
      setMembershipId('');
      setWhen('');
      setNote('');
      onDone();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not record the correction',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Attendance correction">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-[12px] text-ink-3">
          Records a clock event at the time it should have happened — for a
          forgotten in or out. It is added to the ledger, marked as entered by
          you; nothing is erased.
        </p>
        <Field label="Staff member">
          <Select value={membershipId} onChange={(e) => setMembershipId(e.target.value)}>
            <option value="">Choose…</option>
            {active.map((m) => (
              <option key={m.id} value={m.id}>
                {m.user.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <Select value={type} onChange={(e) => setType(e.target.value as 'CLOCK_IN' | 'CLOCK_OUT')}>
              <option value="CLOCK_IN">Clock in</option>
              <option value="CLOCK_OUT">Clock out</option>
            </Select>
          </Field>
          <Field label="When">
            <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
        </div>
        <Field label="Note (optional)">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="e.g. forgot to clock out"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {busy ? 'Recording…' : 'Record correction'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MemberSheet({
  member,
  isSelf,
  onChanged,
  onClock,
}: {
  member: StaffMember;
  isSelf: boolean;
  onChanged: () => void;
  onClock: (m: StaffMember) => Promise<void>;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [history, setHistory] = useState<TimesheetEntry | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getTimesheet(accessToken, onNewToken, {
      from: new Date(Date.now() - 6 * 86_400_000).toISOString(),
      membershipId: member.id,
    })
      .then((rows) => {
        if (!cancelled) setHistory(rows[0] ?? null);
      })
      .catch(() => {
        // Attendance may be permission-gated for some roles; the sheet still
        // shows the profile.
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken, member.id]);

  async function change(body: { role?: string; isActive?: boolean }) {
    if (!accessToken) return;
    try {
      await updateMember(accessToken, onNewToken, member.id, body);
      toast({ title: 'Updated', variant: 'success' });
      onChanged();
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not update',
        variant: 'danger',
      });
    }
  }

  // The owner is deliberately not editable here, and nobody edits themselves —
  // locking yourself out should not be one click. The server enforces both.
  const editable = member.role.key !== 'OWNER' && !isSelf;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[13px] text-ink-2">{member.user.email}</p>
        <p className="mt-1.5 flex items-center gap-1.5">
          <Badge variant="info">{member.role.name}</Badge>
          {statusBadges(member)}
        </p>
        {member.lastEventAt && (
          <p className="mt-1.5 text-[12px] text-ink-3">
            Last clock event {timeShort(member.lastEventAt)}
          </p>
        )}
      </div>

      {member.isActive && (
        <Button variant="primary" onClick={() => void onClock(member)}>
          {member.onShift ? 'Clock out' : 'Clock in'}
        </Button>
      )}

      <section>
        <h3 className="text-label mb-2">Last 7 days</h3>
        {!history || history.sessions.length === 0 ? (
          <p className="text-[13px] text-ink-3">No attendance recorded.</p>
        ) : (
          <>
            <p className="text-[13px]">
              <span className="font-semibold tabular-nums">
                {fmtMinutes(history.totalMinutes)}
              </span>{' '}
              <span className="text-ink-2">
                across {history.sessions.length} session
                {history.sessions.length === 1 ? '' : 's'}
              </span>
            </p>
            <ol className="relative mt-3 ml-1 space-y-3 border-l border-line pl-5">
              {history.sessions.map((s, i) => (
                <li key={i} className="relative animate-fade-up text-[13px]">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute top-1 -left-[26px] size-2.5 rounded-full ring-4 ring-surface',
                      s.out ? 'bg-ink-3' : 'bg-success',
                    )}
                  />
                  <span className="tabular-nums">
                    {timeShort(s.in)} → {s.out ? timeShort(s.out) : 'still on shift'}
                  </span>
                  {s.minutes !== null && (
                    <span className="ml-2 text-ink-3 tabular-nums">
                      {fmtMinutes(s.minutes)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {editable && (
        <section className="space-y-3">
          <h3 className="text-label">Access</h3>
          {member.isActive ? (
            <>
              <Field label="Role">
                <Select
                  value={member.role.key}
                  onChange={(e) => void change({ role: e.target.value })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r.charAt(0) + r.slice(1).toLowerCase()}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmDeactivate(true)}
              >
                Deactivate
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => void change({ isActive: true })}>
              Reactivate
            </Button>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={() => {
          setConfirmDeactivate(false);
          void change({ isActive: false });
        }}
        title={`Deactivate ${member.user.name}?`}
        body="They immediately lose access to this restaurant. Their history and attendance stay on record. You can reactivate them later."
        confirmLabel="Deactivate"
      />
    </div>
  );
}

function InviteModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('CASHIER');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!accessToken || !email.trim()) return;
    setBusy(true);
    try {
      const res = await createInvite(accessToken, onNewToken, { email: email.trim(), role });
      setEmail('');
      setUrl(res.inviteUrl);
      onCreated();
    } catch (err) {
      toast({
        title: err instanceof ApiRequestError ? err.message : 'Could not create invite',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  function done() {
    setUrl(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={done} title={url ? 'Invite created' : 'Invite someone'}>
      {url ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            Share this link with them — it is shown only once. They set their own
            password; you never see it.
          </p>
          <code className="block rounded-lg bg-surface-2 px-3 py-2 font-mono text-[12px] break-all">
            {url}
          </code>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(
                  () => toast({ title: 'Link copied', variant: 'success' }),
                  () => toast({ title: 'Could not copy — select it manually', variant: 'warning' }),
                );
              }}
            >
              <Copy aria-hidden className="size-4" />
              Copy link
            </Button>
            <Button variant="primary" onClick={done}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0) + r.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" type="button" onClick={done}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Creating…' : 'Create invite link'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
