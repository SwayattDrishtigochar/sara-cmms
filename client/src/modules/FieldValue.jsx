import { Check, Minus } from 'lucide-react';
import { Link } from 'react-router';
import { cn, formatDate, formatDateTime, formatDuration, formatNumber, refLabel } from '../lib/format.js';
import { Badge, StatusPill } from '../ui/core.jsx';

const isMidnightLocal = (d) => {
  const date = new Date(d);
  return date.getHours() === 0 && date.getMinutes() === 0;
};

/** AI health 0–100 with a colour band. */
export const HealthScore = ({ value }) => {
  if (value == null) return <span className="text-subtle">—</span>;
  const tone = value >= 80 ? 'running' : value >= 60 ? 'warn' : 'critical';
  return (
    <Badge tone={tone} className="tabular">
      {Math.round(value)}
    </Badge>
  );
};

const RefChip = ({ refModule, value }) => {
  if (value == null) return <span className="text-subtle">—</span>;
  const id = typeof value === 'object' ? value._id : value;
  const label = typeof value === 'object' ? refLabel(value) : `${String(id).slice(-6)}`;
  return (
    <Link
      to={`/m/${refModule}/${id}`}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex max-w-full items-center truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-fg hover:bg-surface-3 hover:text-brand"
      title={label}
    >
      <span className="truncate">{label}</span>
    </Link>
  );
};

/** Read-only rendering of any registry field value. `compact` is for table cells. */
export const FieldValue = ({ meta, value, compact = false }) => {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return <span className="text-subtle">—</span>;
  }
  if (meta.key === 'healthScore') return <HealthScore value={value} />;
  if (meta.key === 'assetStatus') return <StatusPill status={value} />;

  switch (meta.type) {
    case 'enum':
      return <Badge value={value} />;
    case 'ref':
      return <RefChip refModule={meta.ref} value={value} />;
    case 'refs':
      return (
        <span className="flex flex-wrap gap-1">
          {value.slice(0, compact ? 2 : 50).map((v) => (
            <RefChip key={typeof v === 'object' ? v._id : v} refModule={meta.ref} value={v} />
          ))}
          {compact && value.length > 2 && <span className="text-xs text-subtle">+{value.length - 2}</span>}
        </span>
      );
    case 'date':
      return (
        <span className="tabular whitespace-nowrap">
          {isMidnightLocal(value) ? formatDate(value) : formatDateTime(value)}
        </span>
      );
    case 'number':
      if (meta.unit === 's' && value >= 60) return <span className="tabular">{formatDuration(value)}</span>;
      return <span className="tabular">{formatNumber(value, { unit: meta.unit })}</span>;
    case 'boolean':
      return value ? (
        <Check className="size-4 text-running" aria-label="Yes" />
      ) : (
        <Minus className="size-4 text-subtle" aria-label="No" />
      );
    case 'tags':
      return (
        <span className="flex flex-wrap gap-1">
          {value.slice(0, compact ? 3 : 100).map((t) => (
            <Badge key={t} tone="neutral">
              {t}
            </Badge>
          ))}
        </span>
      );
    case 'text':
      return compact ? (
        <span className="line-clamp-1 text-muted">{value}</span>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{value}</p>
      );
    case 'object':
      if (meta.key === 'message') return <span className="font-medium">{value.title}</span>;
      if (meta.key === 'durations')
        return <span className="tabular">{formatDuration(value.timeInProgress)}</span>;
      if (compact) {
        // A table cell shows the first filled sub-field (e.g. the station of a bin's last scan).
        const first = meta.fields.find((f) => !f.hidden && value[f.key] != null && value[f.key] !== '');
        return first ? (
          <FieldValue meta={first} value={value[first.key]} compact />
        ) : (
          <span className="text-subtle">—</span>
        );
      }
      return <ObjectGrid fields={meta.fields} value={value} />;
    case 'array':
      if (meta.of) {
        return (
          <span className="flex flex-wrap gap-1">
            {value.map((v) => (
              <Badge key={String(v)} tone="neutral">
                {String(v)}
              </Badge>
            ))}
          </span>
        );
      }
      return compact ? (
        <span className="text-xs text-muted">
          {value.length} {value.length === 1 ? 'item' : 'items'}
        </span>
      ) : (
        <RowsTable fields={meta.fields} rows={value} />
      );
    case 'mixed':
      return compact ? (
        <span className="text-subtle">…</span>
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      );
    default:
      return <span className={cn(compact && 'line-clamp-1')}>{String(value)}</span>;
  }
};

export const ObjectGrid = ({ fields, value }) => (
  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
    {fields
      .filter((f) => !f.hidden && !f.secret)
      .map((f) =>
        f.type === 'array' && !f.of ? (
          <div key={f.key} className="sm:col-span-2">
            <dt className="mb-1 text-xs font-medium text-subtle">{f.label}</dt>
            <dd>
              <FieldValue meta={f} value={value?.[f.key]} />
            </dd>
          </div>
        ) : (
          <div key={f.key} className="min-w-0">
            <dt className="text-xs font-medium text-subtle">{f.label}</dt>
            <dd className="mt-0.5 text-sm">
              <FieldValue meta={f} value={value?.[f.key]} />
            </dd>
          </div>
        ),
      )}
  </dl>
);

const RowsTable = ({ fields, rows }) => {
  const cols = fields.filter((f) => !f.hidden && !(f.type === 'array' && !f.of) && f.type !== 'object');
  const nested = fields.filter((f) => f.type === 'array' && !f.of);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            {cols.map((c) => (
              <th key={c.key} className="px-3 py-2 font-medium whitespace-nowrap">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={row._id ?? i} className="align-top">
              {cols.map((c) => (
                <td key={c.key} className="px-3 py-2">
                  <FieldValue meta={c} value={row[c.key]} compact />
                </td>
              ))}
              {nested.length > 0 && (
                <td className="px-3 py-2">
                  {nested.map((n) => (
                    <div key={n.key} className="space-y-1">
                      {(row[n.key] ?? []).map((sub, j) => (
                        <div key={sub._id ?? j} className="flex items-center gap-2 text-xs">
                          {'completed' in sub &&
                            (sub.completed ? (
                              <Check className="size-3.5 text-running" />
                            ) : (
                              <Minus className="size-3.5 text-subtle" />
                            ))}
                          <span>{sub.task ?? sub.breakType ?? refLabel(sub)}</span>
                          {sub.breakStartTime && (
                            <span className="text-subtle">
                              {sub.breakStartTime}–{sub.breakEndTime}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
