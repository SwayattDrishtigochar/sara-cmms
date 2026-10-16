import { Info, OctagonAlert, RefreshCw, TriangleAlert } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSession } from '../auth/useAuth.js';
import { cn } from '../lib/format.js';
import { fieldLabel, formatValue } from '../machines/telemetry.js';
import { AiProvenance, Badge } from '../ui/core.jsx';
import { useScan } from './useAnomalies.js';

/** Severity meta: the icon and the word always travel with the colour. `soft` tints chips and tiles. */
export const SEVERITY = {
  info: {
    label: 'Info',
    icon: Info,
    tone: 'info',
    rank: 0,
    text: 'text-info',
    soft: 'border-info/40 bg-info/5',
    ring: 'border-info ring-info/25',
  },
  warning: {
    label: 'Warning',
    icon: TriangleAlert,
    tone: 'warn',
    rank: 1,
    text: 'text-warn',
    soft: 'border-warn/40 bg-warn/5',
    ring: 'border-warn ring-warn/25',
  },
  critical: {
    label: 'Critical',
    icon: OctagonAlert,
    tone: 'critical',
    rank: 2,
    text: 'text-critical',
    soft: 'border-critical/40 bg-critical/5',
    ring: 'border-critical ring-critical/25',
  },
};
export const severityOf = (severity) => SEVERITY[severity] ?? SEVERITY.info;

export const STATE_LABEL = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  false_positive: 'False positive',
};

/** "vibration_high" → "Vibration high". */
export const typeLabel = (type) => {
  const t = String(type ?? '')
    .replace(/_/g, ' ')
    .trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Anomaly';
};

/** `{ id, name, tag, type }` of an anomaly's machine, whether the ref came populated or not. */
export const assetOf = (anomaly) => {
  const a = anomaly?.assetId;
  if (a && typeof a === 'object') {
    return {
      id: String(a._id),
      name: a.name ?? 'Machine',
      tag: a.assetTag ?? null,
      type: a.typeOfAsset ?? null,
    };
  }
  return { id: a ? String(a) : null, name: 'Machine', tag: null, type: null };
};

/** "Act within …": hours up to two days, then days. */
export const urgencyText = (hours) => {
  if (hours == null) return null;
  if (hours < 1) return 'the hour';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
};

/** Where an anomaly opens: the Anomalies page with its sheet. */
export const anomalyPath = (id) => `/anomalies?open=${id}`;

export const SeverityBadge = ({ severity, className }) => {
  const s = severityOf(severity);
  return (
    <Badge tone={s.tone} className={className}>
      <s.icon className="size-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
};

export const StateBadge = ({ state }) => <Badge value={state}>{STATE_LABEL[state] ?? state}</Badge>;

/** The AI's deviation text ("+4.2σ"), or observed vs expected as a percentage. */
export const deviationOf = (p) => {
  if (p?.deviation) return p.deviation;
  if (typeof p?.observed === 'number' && typeof p?.expected === 'number' && p.expected !== 0) {
    const pct = Math.round(((p.observed - p.expected) / Math.abs(p.expected)) * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
  }
  return null;
};

/** One flagged parameter: label and deviation, tinted by the anomaly's severity, with the numbers on hover. */
export const ParamChip = ({ param, severity = 'critical' }) => {
  const dev = deviationOf(param);
  const unit = param.unit ? ` ${param.unit}` : '';
  const numbers =
    typeof param.observed === 'number'
      ? `Observed ${formatValue(param.observed)}${unit}, expected ${formatValue(param.expected)}${unit}`
      : undefined;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs text-fg',
        severityOf(severity).soft,
      )}
      title={numbers}
    >
      <span className="text-muted">{fieldLabel(param.field)}</span>
      {dev && <span className="font-semibold tabular">{dev}</span>}
    </span>
  );
};

/**
 * Who decided and when (model + time), with Re-scan for owners and admins: every AI finding carries it.
 * Re-scan sends every machine of the company to the AI (`POST /api/ai/scan`).
 */
export const ScanProvenance = ({ model, at, className }) => {
  const ctx = useSession();
  const scan = useScan();
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      <AiProvenance model={model} at={at} />
      {['owner', 'admin'].includes(ctx?.role) && (
        <button
          type="button"
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-ai hover:underline disabled:cursor-wait disabled:opacity-70"
        >
          <RefreshCw
            className={cn('size-3', scan.isPending && 'animate-spin motion-reduce:animate-none')}
            aria-hidden
          />
          {scan.isPending ? 'Scanning…' : 'Re-scan'}
        </button>
      )}
    </div>
  );
};

const MD =
  'text-sm leading-relaxed text-fg [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:text-brand [&_a]:underline [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_th]:border-b [&_th]:border-border [&_th]:py-1 [&_th]:text-left [&_th]:font-medium [&_td]:border-b [&_td]:border-border [&_td]:py-1 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted';

const Anchor = ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />;

/** Markdown from the AI (GitHub flavour), styled for cards. */
export const Markdown = ({ children, className }) => (
  <div className={cn(MD, className)}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: Anchor }}>
      {children}
    </ReactMarkdown>
  </div>
);
