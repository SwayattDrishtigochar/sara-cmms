import { ArrowRight, Gauge } from 'lucide-react';
import { Link } from 'react-router';
import { cellText } from '../blocks/DataTable.jsx';
import { formatNumber } from '../lib/format.js';
import { Badge, Card, CardHeader } from '../ui/core.jsx';
import { Viz } from '../viz/Viz.jsx';
import { VIZ_LABEL } from '../viz/vizData.js';

/** A changed field as text: a time range by its words, other objects as JSON. */
const valueText = (v) =>
  v != null && typeof v === 'object'
    ? typeof v.text === 'string'
      ? v.text
      : JSON.stringify(v)
    : cellText(v);

/** Key facts of a KPI definition: chart, range, sources, formula, target and thresholds. */
export const KpiDefinition = ({ kpi = {} }) => {
  const unit = kpi.unit || undefined;
  const t = kpi.thresholds;
  const rows = [
    ['Chart', VIZ_LABEL[kpi.viz] ?? kpi.viz],
    ['Time range', kpi.timeRange?.text],
    ['Data', kpi.sources?.map((s) => `${s.key} ← ${s.tool}`).join(', ')],
    ['Formula', kpi.formula],
    ['Unit', kpi.unit],
    ['Target', kpi.target != null ? formatNumber(kpi.target, { unit }) : null],
    [
      'Thresholds',
      t && (t.warn != null || t.critical != null)
        ? [
            t.warn != null && `warn ${formatNumber(t.warn, { unit })}`,
            t.critical != null && `critical ${formatNumber(t.critical, { unit })}`,
            t.direction === 'lower_is_better' ? 'lower is better' : 'higher is better',
          ]
            .filter(Boolean)
            .join(' · ')
        : null,
    ],
    ['Command Center', kpi.pinned ? 'Pinned' : null],
  ].filter(([, v]) => v != null && v !== '');
  return (
    <dl className="grid grid-cols-[minmax(6.5rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 break-words text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
};

const Changes = ({ changes }) => (
  <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-sm">
      <caption className="sr-only">Changes</caption>
      <thead className="bg-surface-2 text-xs text-muted">
        <tr>
          <th scope="col" className="px-3 py-1.5 text-left font-medium">
            Field
          </th>
          <th scope="col" className="px-3 py-1.5 text-left font-medium">
            Now
          </th>
          <th scope="col" className="px-3 py-1.5 text-left font-medium">
            After
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {changes.map((c) => (
          <tr key={c.field}>
            <td className="px-3 py-1.5 text-muted">{c.field}</td>
            <td className="px-3 py-1.5 break-all text-muted line-through decoration-subtle">
              {valueText(c.from)}
            </td>
            <td className="px-3 py-1.5 break-all font-medium text-fg">{valueText(c.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/** Confirm-card body for `action: 'kpi'` (create_kpi / update_kpi): live preview, definition, changes. */
export const KpiPreview = ({ payload = {} }) => (
  <div className="space-y-3">
    {payload.result && <Viz result={payload.result} height={200} />}
    <KpiDefinition kpi={payload.kpi} />
    {payload.changes?.length > 0 && <Changes changes={payload.changes} />}
  </div>
);

/** Chat `kpi` block: { id?, kpi, result } — the KPI as it will look (or looks) on the KPI Builder. */
export const KpiPreviewBlock = ({ payload = {} }) => {
  const { id, kpi = {}, result } = payload;
  const title = kpi.title ?? result?.title ?? 'KPI';
  return (
    <Card className="overflow-hidden">
      <CardHeader
        icon={Gauge}
        title={title}
        subtitle={[VIZ_LABEL[kpi.viz ?? result?.viz], result?.timeRange?.label ?? kpi.timeRange?.text]
          .filter(Boolean)
          .join(' · ')}
        actions={id ? <Badge tone="success">Saved</Badge> : <Badge tone="ai">Preview</Badge>}
      />
      <div className="space-y-3 p-3">
        {result ? <Viz result={result} height={200} /> : <KpiDefinition kpi={kpi} />}
        {id && (
          <Link
            to="/kpis"
            className="inline-flex items-center gap-1 text-sm font-medium text-brand hover:underline"
          >
            Open KPI Builder <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </Card>
  );
};
