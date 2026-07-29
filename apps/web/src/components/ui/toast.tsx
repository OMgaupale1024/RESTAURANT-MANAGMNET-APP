'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

type Variant = 'success' | 'warning' | 'danger' | 'info';

type Toast = { id: number; title: string; description?: string; variant: Variant };

const DURATION = 4000;

const ICONS = {
  success: { Icon: CheckCircle2, cls: 'text-success-text' },
  warning: { Icon: AlertTriangle, cls: 'text-warning-text' },
  danger: { Icon: XCircle, cls: 'text-danger-text' },
  info: { Icon: Info, cls: 'text-info-text' },
} as const;

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

/** `const toast = useToast(); toast({ title, variant })` */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const push = useCallback((t: Omit<Toast, 'id'>) => {
    setToasts((prev) => [...prev, { ...t, id: nextId.current++ }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      {/* Positioning-only wrapper. Each toast carries its own live-region role
          (below) so an error can interrupt (assertive) while success/info stay
          polite — one container can only hold a single politeness. */}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-full max-w-[360px] flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Owns its dismissal timer so hover can pause it; the progress bar is the
 * timer's visual twin (CSS animation paused in lockstep). The JS timer, not
 * the animation, dismisses — reduced-motion zeroes animations but must not
 * flash toasts away.
 */
function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(DURATION);

  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(onDone, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, onDone]);

  const { Icon, cls } = ICONS[toast.variant];
  // Errors are time-sensitive — interrupt (assertive/alert). Everything else
  // waits its turn (polite/status).
  const assertive = toast.variant === 'danger';

  return (
    <div
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto relative animate-slide-up overflow-hidden rounded-xl border border-line bg-surface shadow-[0_4px_16px_rgb(0_0_0/0.08)]"
    >
      <div className="flex items-start gap-3 p-4">
        <Icon aria-hidden className={`mt-px size-4 shrink-0 ${cls}`} />
        <div className="min-w-0">
          <p className="text-[13px] leading-5 font-medium">{toast.title}</p>
          {toast.description && (
            <p className="mt-0.5 text-[12px] leading-4.5 text-ink-2">
              {toast.description}
            </p>
          )}
        </div>
      </div>
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-ink/15"
        style={{
          animation: `toast-progress ${DURATION}ms linear both`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  );
}
