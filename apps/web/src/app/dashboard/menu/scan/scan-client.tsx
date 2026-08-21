'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ImagePlus,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  ApiRequestError,
  cancelImport,
  extractMenu,
  getImportSession,
  importMenu,
  saveImportDraft,
  type MenuImportSession,
  type ReviewMenu,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { processFile, processVideoFrame, isSupportedType, type ScannedImage } from '@/lib/image';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { ReviewMenuEditor } from './review-menu';

const MAX_PAGES = 8;

type Step = 'source' | 'camera' | 'processing' | 'review' | 'done';

export function ScanClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);
  const toast = useToast();
  const router = useRouter();

  const [step, setStep] = useState<Step>('source');
  const [pages, setPages] = useState<ScannedImage[]>([]);
  const [session, setSession] = useState<MenuImportSession | null>(null);
  const [menu, setMenu] = useState<ReviewMenu | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<{ created: number; updated: number; skipped: number } | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(accessToken);
  useEffect(() => {
    tokenRef.current = accessToken;
  }, [accessToken]);

  // Resume a session named in the URL (?session=id) — a page refresh mid-review
  // lands back on the review, not at the start (spec §16, §25).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('session');
    if (!id || !tokenRef.current) return;
    let cancelled = false;
    getImportSession(tokenRef.current, onNewToken, id)
      .then((s) => {
        if (cancelled || !s.result || s.status === 'IMPORTED' || s.status === 'CANCELLED')
          return;
        setSession(s);
        setMenu(s.result);
        setStep('review');
      })
      .catch(() => {
        /* stale link — just start fresh */
      });
    return () => {
      cancelled = true;
    };
  }, [onNewToken]);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const room = MAX_PAGES - pages.length;
    const chosen = Array.from(files).slice(0, room);
    if (files.length > room) {
      toast({ title: `Up to ${MAX_PAGES} pages — extra photos were skipped.`, variant: 'warning' });
    }
    for (const file of chosen) {
      if (!isSupportedType(file)) {
        toast({ title: `${file.name} is not a JPG, PNG, or WEBP.`, variant: 'danger' });
        continue;
      }
      try {
        const img = await processFile(file);
        setPages((p) => [...p, img]);
      } catch {
        toast({ title: `Could not read ${file.name}.`, variant: 'danger' });
      }
    }
  };

  const removePage = (i: number) => setPages((p) => p.filter((_, idx) => idx !== i));

  async function runExtract() {
    const token = tokenRef.current;
    if (!token || pages.length === 0) return;
    setStep('processing');
    setError('');
    try {
      const s = await extractMenu(token, onNewToken, pages.map((p) => p.dataUrl));
      setSession(s);
      setMenu(s.result);
      router.replace(`/dashboard/menu/scan?session=${s.id}`);
      setStep('review');
    } catch (e) {
      setError(
        e instanceof ApiRequestError
          ? e.message
          : "We couldn't read this menu. Please try again.",
      );
      setStep('source');
    }
  }

  async function saveDraft() {
    const token = tokenRef.current;
    if (!token || !session || !menu) return;
    setBusy(true);
    try {
      await saveImportDraft(token, onNewToken, session.id, menu);
      toast({ title: 'Draft saved. You can finish this import later.', variant: 'success' });
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Could not save the draft.',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    const token = tokenRef.current;
    if (!token || !session || !menu) return;
    setBusy(true);
    try {
      const res = await importMenu(token, onNewToken, session.id, menu);
      setSummary(res.summary);
      setStep('done');
    } catch (e) {
      toast({
        title: e instanceof ApiRequestError ? e.message : 'Import failed. Nothing was changed — try again.',
        variant: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }

  async function cancelAndLeave() {
    const token = tokenRef.current;
    if (token && session) {
      try {
        await cancelImport(token, onNewToken, session.id);
      } catch {
        /* leaving anyway */
      }
    }
    router.push('/dashboard/menu');
  }

  const selectedCount =
    menu?.categories.reduce(
      (n, c) => n + c.items.filter((i) => i.action !== 'skip').length,
      0,
    ) ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center gap-2">
        <Link
          href="/dashboard/menu"
          className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
          aria-label="Back to menu"
        >
          <ArrowLeft className="size-5" />
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Scan menu</h1>
      </div>

      {step === 'source' && (
        <SourceStep
          pages={pages}
          error={error}
          onPickCamera={() => setStep('camera')}
          onPickUpload={() => fileRef.current?.click()}
          onRemovePage={removePage}
          onRead={runExtract}
        />
      )}

      {step === 'camera' && (
        <CameraStep
          disabled={pages.length >= MAX_PAGES}
          count={pages.length}
          onCapture={(img) => setPages((p) => [...p, img])}
          onDone={() => setStep('source')}
        />
      )}

      {step === 'processing' && <ProcessingStep pageCount={pages.length} />}

      {step === 'review' && menu && (
        <div>
          <ReviewMenuEditor menu={menu} onChange={setMenu} />
          <div className="sticky bottom-0 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/80 py-3 backdrop-blur">
            <Button variant="ghost" onClick={cancelAndLeave} disabled={busy}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={saveDraft} disabled={busy}>
              Save as draft
            </Button>
            <Button variant="primary" onClick={runImport} disabled={busy || selectedCount === 0}>
              {busy ? 'Importing…' : `Import ${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && summary && <DoneStep summary={summary} />}

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- source */

function SourceStep({
  pages,
  error,
  onPickCamera,
  onPickUpload,
  onRemovePage,
  onRead,
}: {
  pages: ScannedImage[];
  error: string;
  onPickCamera: () => void;
  onPickUpload: () => void;
  onRemovePage: (i: number) => void;
  onRead: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-ink-2">
        For the best scan, use good lighting and keep the whole menu visible.
        Avoid shadows, glare, and blurry photos. You can add several pages.
      </p>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-danger-text"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={onPickCamera}
          className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-4 py-8 text-center transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <Camera aria-hidden className="size-7 text-ink-2" />
          <span className="text-sm font-medium">Scan with camera</span>
          <span className="text-[12px] text-ink-3">Take a photo of the menu</span>
        </button>
        <button
          type="button"
          onClick={onPickUpload}
          className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-4 py-8 text-center transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        >
          <Upload aria-hidden className="size-7 text-ink-2" />
          <span className="text-sm font-medium">Upload menu photos</span>
          <span className="text-[12px] text-ink-3">JPG, PNG or WEBP</span>
        </button>
      </div>

      {pages.length > 0 && (
        <div>
          <p className="text-label mb-2">
            {pages.length} page{pages.length === 1 ? '' : 's'}
          </p>
          <div className="flex flex-wrap gap-3">
            {pages.map((p, i) => (
              <div key={i} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.dataUrl}
                  alt={`Page ${i + 1}`}
                  className="h-28 w-24 rounded-lg border border-line object-cover"
                />
                {p.warnings.length > 0 && (
                  <span
                    title={p.warnings.map((w) => w.message).join(' ')}
                    className="absolute top-1 left-1 rounded bg-warning/90 p-0.5 text-warning-text"
                  >
                    <AlertTriangle aria-hidden className="size-3.5" />
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onRemovePage(i)}
                  aria-label={`Remove page ${i + 1}`}
                  className="absolute -top-2 -right-2 rounded-full border border-line bg-surface p-1 text-ink-3 shadow-sm hover:text-danger"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Button variant="primary" onClick={onRead}>
              Read menu
            </Button>
            <Button variant="ghost" onClick={onPickUpload}>
              <ImagePlus aria-hidden className="size-4" />
              Add more
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- camera */

function CameraStep({
  disabled,
  count,
  onCapture,
  onDone,
}: {
  disabled: boolean;
  count: number;
  onCapture: (img: ScannedImage) => void;
  onDone: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [failed, setFailed] = useState(false);
  const [lastWarnings, setLastWarnings] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (!active) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
      } catch {
        setFailed(true);
      }
    })();
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const capture = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const img = processVideoFrame(v);
    setLastWarnings(img.warnings.map((w) => w.message));
    onCapture(img);
  };

  if (failed) {
    return (
      <div className="rounded-xl border border-line bg-surface p-6 text-center">
        <Camera aria-hidden className="mx-auto mb-3 size-6 text-ink-3" />
        <p className="text-sm font-medium">Camera unavailable</p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-2">
          We couldn&apos;t open the camera. Check permissions, or go back and
          upload photos instead.
        </p>
        <Button variant="secondary" onClick={onDone} className="mt-4">
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden rounded-xl bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {/* Guide overlay (spec §2). */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-6 rounded-lg border-2 border-dashed border-white/70"
        >
          <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[12px] font-medium tracking-wide text-white/80">
            PLACE MENU HERE
          </span>
        </div>
        <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-[11px] text-white/80">
          Keep the whole menu visible and well lit
        </p>
      </div>

      {lastWarnings.length > 0 && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning-text"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          {lastWarnings.join(' ')} You can retake it, or keep it and continue.
        </p>
      )}

      <div className="flex items-center justify-center gap-2">
        <Button variant="secondary" onClick={onDone}>
          {count > 0 ? `Done (${count})` : 'Cancel'}
        </Button>
        <Button variant="primary" onClick={capture} disabled={disabled}>
          <Camera aria-hidden className="size-4" />
          Capture
        </Button>
      </div>
      {disabled && (
        <p className="text-center text-[12px] text-ink-3">
          Maximum {MAX_PAGES} pages reached.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- processing */

function ProcessingStep({ pageCount }: { pageCount: number }) {
  // Honest staged checklist: the photo check already ran on the device; reading
  // is the single vision call in flight. No fabricated sub-step timing.
  return (
    <div className="rounded-xl border border-line bg-surface p-8">
      <ul className="mx-auto max-w-xs space-y-3 text-sm">
        <li className="flex items-center gap-3 text-ink-2">
          <Check aria-hidden className="size-4 text-success-text" />
          {pageCount} photo{pageCount === 1 ? '' : 's'} checked
        </li>
        <li className="flex items-center gap-3 font-medium text-ink">
          <Loader2 aria-hidden className="size-4 animate-spin text-brand" />
          Reading your menu…
        </li>
        <li className="flex items-center gap-3 text-ink-3">
          <span className="size-4" />
          Detecting categories, prices and duplicates
        </li>
      </ul>
      <p className="mt-6 text-center text-[12px] text-ink-3">
        This usually takes a few seconds.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- done */

function DoneStep({
  summary,
}: {
  summary: { created: number; updated: number; skipped: number };
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-8 text-center">
      <CheckCircle2 aria-hidden className="mx-auto mb-3 size-8 text-success-text" />
      <p className="text-sm font-medium">Menu imported</p>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-2">
        {summary.created} new item{summary.created === 1 ? '' : 's'} added
        {summary.updated > 0 && `, ${summary.updated} updated`}. They are live on
        the POS now.
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        <Link href="/dashboard/menu">
          <Button variant="primary">View menu</Button>
        </Link>
        <Link href="/dashboard/menu/scan">
          <Button variant="ghost">
            <RefreshCw aria-hidden className="size-4" />
            Scan another
          </Button>
        </Link>
      </div>
    </div>
  );
}
