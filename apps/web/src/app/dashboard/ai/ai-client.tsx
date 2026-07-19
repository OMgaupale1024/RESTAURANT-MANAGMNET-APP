'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Sparkles } from 'lucide-react';
import { ApiRequestError, getInsights, type AiInsight } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The daily briefing.
 *
 * Every card shows HOW it was produced (the method badge) and WHAT from (the
 * expandable evidence). That labelling is the promise that no number here is
 * invented — a statistical forecast also shows its confidence, honestly,
 * including "low". Cold-start restaurants get nothing rather than a fabrication.
 */

const METHOD_LABEL: Record<string, string> = {
  DETERMINISTIC: 'Rule',
  STATISTICAL: 'Statistical',
  LLM: 'AI-written',
};

export function AiClient() {
  const { accessToken, setAccessToken } = useAuth();
  const onNewToken = useCallback((t: string) => setAccessToken(t), [setAccessToken]);

  const [insights, setInsights] = useState<AiInsight[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    getInsights(accessToken, onNewToken)
      .then((res) => {
        if (cancelled) return;
        setInsights(res.insights);
        setGeneratedAt(res.generatedAt);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof ApiRequestError ? e.message : 'Could not load insights');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, onNewToken]);

  const warnings = (insights ?? []).filter((i) => i.severity === 'warning');
  const info = (insights ?? []).filter((i) => i.severity !== 'warning');

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">AI Center</h1>
        {generatedAt && (
          <span className="text-[12px] text-ink-3 tabular-nums">
            Updated {new Date(generatedAt).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-2">
        Every insight shows how it was worked out and from what data. Nothing here is guessed —
        a thin history produces fewer insights, never invented ones.
      </p>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      )}

      {insights === null ? (
        <div className="mt-6 space-y-3" aria-label="Loading insights">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : insights.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={Sparkles}
            title="Nothing to flag yet"
            body="Once you have a few days of sales, demand forecasts and reorder suggestions appear here. No history is invented in the meantime."
          />
        </div>
      ) : (
        <div className="mt-6 space-y-8">
          {warnings.length > 0 && (
            <InsightGroup
              title="Needs attention"
              icon={AlertTriangle}
              tone="text-warning-text"
              insights={warnings}
            />
          )}
          {info.length > 0 && (
            <InsightGroup
              title="Good to know"
              icon={Info}
              tone="text-info-text"
              insights={info}
            />
          )}
        </div>
      )}
    </div>
  );
}

function InsightGroup({
  title,
  icon: Icon,
  tone,
  insights,
}: {
  title: string;
  icon: typeof Info;
  tone: string;
  insights: AiInsight[];
}) {
  return (
    <section>
      <h2 className="text-label mb-2 flex items-center gap-1.5">
        <Icon aria-hidden className={cn('size-3.5', tone)} />
        {title}
        <span className="text-ink-3 tabular-nums">· {insights.length}</span>
      </h2>
      <div className="space-y-3">
        {insights.map((insight, i) => (
          <InsightCard key={`${insight.type}-${i}`} insight={insight} />
        ))}
      </div>
    </section>
  );
}

function InsightCard({ insight }: { insight: AiInsight }) {
  const [open, setOpen] = useState(false);
  const showConfidence = insight.confidence && insight.confidence !== 'NONE';

  return (
    <Card className={cn(insight.severity === 'warning' && 'border-warning/40')}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{insight.title}</h3>
        <Badge variant={insight.method === 'DETERMINISTIC' ? 'info' : 'neutral'}>
          {METHOD_LABEL[insight.method] ?? insight.method}
        </Badge>
        {showConfidence && (
          <Badge variant={insight.confidence === 'LOW' ? 'warning' : 'neutral'}>
            {insight.confidence?.toLowerCase()} confidence
          </Badge>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-2">{insight.detail}</p>

      {/* The evidence. Expand/collapse via grid-template-rows (DESIGN §7). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-2 inline-flex items-center gap-1 rounded text-[12px] font-medium text-ink-3 transition-colors duration-120 hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        Based on
        <ChevronDown
          aria-hidden
          className={cn('size-3.5 transition-transform duration-240', open && 'rotate-180')}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows] duration-240 ease-(--ease-out-quart)"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <p className="pt-1.5 text-[12px] text-ink-3">{insight.basis}</p>
        </div>
      </div>
    </Card>
  );
}
