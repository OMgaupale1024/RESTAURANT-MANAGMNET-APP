'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, getInsights, type AiInsight } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * The daily briefing.
 *
 * Every card shows HOW it was produced (the method badge) and WHAT from (the
 * basis line). That labelling is not decoration — it is the promise that no
 * number here is invented. A statistical forecast also shows its confidence,
 * honestly, including "low".
 */
export function AiClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [insights, setInsights] = useState<AiInsight[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getInsights(accessToken, onNewToken);
        if (!cancelled) {
          setInsights(res.insights);
          setGeneratedAt(res.generatedAt);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load insights');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken]);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold tracking-tight">AI Center</h1>
        {generatedAt && (
          <span className="text-xs text-black/50 dark:text-white/50">
            {new Date(generatedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Every insight shows how it was worked out and from what data. Nothing
        here is guessed.
      </p>

      {error && (
        <p
          role="alert"
          className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
        >
          {error}
        </p>
      )}

      {!insights ? (
        <p className="mt-6 text-sm text-black/60 dark:text-white/60">Loading…</p>
      ) : insights.length === 0 ? (
        <div className="mt-6 rounded-lg border border-black/10 p-6 dark:border-white/15">
          <h2 className="font-semibold">Nothing to flag yet</h2>
          <p className="mt-2 text-sm text-black/70 dark:text-white/70">
            Once you have a few days of sales, forecasts and reorder suggestions
            will appear here. No history is invented in the meantime.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {insights.map((i, idx) => (
            <li
              key={`${i.type}-${idx}`}
              className={`rounded-lg border p-4 ${
                i.severity === 'warning'
                  ? 'border-orange-500/40 bg-orange-500/5'
                  : 'border-black/10 dark:border-white/15'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.title}</span>
                <MethodBadge method={i.method} />
                {i.confidence && i.confidence !== 'NONE' && (
                  <ConfidenceBadge confidence={i.confidence} />
                )}
              </div>
              <p className="mt-1 text-sm text-black/70 dark:text-white/70">
                {i.detail}
              </p>
              {/* The evidence. This is what makes it explainable. */}
              <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                Based on: {i.basis}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MethodBadge({ method }: { method: string }) {
  // The label is always spelled out — a reader must never have to guess whether
  // a number is a rule, a statistic, or a language model.
  const map: Record<string, string> = {
    DETERMINISTIC: 'Rule',
    STATISTICAL: 'Statistical',
    LLM: 'AI-written',
  };
  return (
    <span
      title={`Method: ${method.toLowerCase()}`}
      className="rounded bg-black/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-black/60 dark:bg-white/15 dark:text-white/60"
    >
      {map[method] ?? method}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const tone =
    confidence === 'HIGH'
      ? 'text-green-700 dark:text-green-300'
      : confidence === 'MEDIUM'
        ? 'text-black/60 dark:text-white/60'
        : 'text-orange-700 dark:text-orange-300';
  return (
    <span className={`text-[10px] font-medium uppercase ${tone}`}>
      {confidence} confidence
    </span>
  );
}
