import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChartLine, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { cn, formatDateTime, getFormatPrefs } from '../lib/format.js';
import { SERIES_MAX, SERIES_VARS, seriesColor, TelemetryChart } from '../ui/charts.jsx';
import { Button, Card, CardHeader, Skeleton } from '../ui/core.jsx';
import { Select } from '../ui/form.jsx';
import { bandOf, bandText, fieldGroup, fieldLabel, formatValue, GROUP_ORDER } from './telemetry.js';

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

const RANGES = [
  { value: '1h', label: '1 h' },
  { value: '6h', label: '6 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
];

const RangeSwitch = ({ value, onChange }) => (
  <fieldset className="flex rounded-lg border border-border bg-surface-2 p-0.5">
    <legend className="sr-only">Time range</legend>
    {RANGES.map((r) => (
      <button
        key={r.value}
        type="button"
        aria-pressed={value === r.value}
        onClick={() => onChange(r.value)}
        className={cn(
          'h-7 rounded-md px-2.5 text-xs font-medium tabular transition-colors',
          value === r.value ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg',
        )}
      >
        {r.label}
      </button>
    ))}
  </fieldset>
);

/** Accessible twin of the charts: every plotted value by time, newest first. */
const DataTable = ({ panes }) => {
  const series = panes.flatMap((p) => p.series.map((s) => ({ ...s, unit: p.unit })));
  const times = [...new Set(series.flatMap((s) => s.points.map(([t]) => t)))].sort((a, b) => b - a);
  const lookup = series.map((s) => new Map(s.points));
  return (
    <div className="max-h-72 overflow-auto scrollbar-thin">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface-2 text-left text-muted">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Time
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="px-4 py-2 text-right font-medium whitespace-nowrap">
                {s.label}
                {s.unit && <span className="font-normal text-subtle"> ({s.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border tabular">
          {times.map((t) => (
            <tr key={t}>
              <td className="px-4 py-1.5 whitespace-nowrap text-muted">{formatDateTime(t)}</td>
              {lookup.map((m, i) => (
                <td key={series[i].key} className="px-4 py-1.5 text-right text-fg">
                  {m.has(t) ? formatValue(m.get(t)) : '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/**
 * Trends for chosen parameters. Fields that share a unit share a chart; other units get their own chart
 * underneath (one y-axis each, crosshair synced). Colours stay with a parameter until it is removed.
 */
export const TrendsCard = ({ assetId, fields }) => {
  const [range, setRange] = useState('6h');
  const [picks, setPicks] = useState(null); // slot index = colour; null marks a freed slot
  const [showTable, setShowTable] = useState(false);
  const specs = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields]);
  const defaults = useMemo(() => {
    const keys = fields.filter((f) => f.key).map((f) => f.field);
    return (keys.length ? keys : fields.slice(0, 3).map((f) => f.field)).slice(0, SERIES_MAX);
  }, [fields]);
  const slots = picks ?? defaults;
  const selected = useMemo(() => slots.filter(Boolean), [slots]);

  const add = (field) => {
    const next = [...slots];
    const free = next.indexOf(null);
    if (free === -1) next.push(field);
    else next[free] = field;
    setPicks(next);
  };
  const remove = (field) => setPicks(slots.map((f) => (f === field ? null : f)));

  const query = useQuery({
    queryKey: ['telemetry', 'series', assetId, selected.join(','), range],
    queryFn: ({ signal }) =>
      api('/telemetry/series', { query: { assetId, fields: selected.join(','), range }, signal }),
    enabled: selected.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: range === '1h' ? 30_000 : 120_000,
  });

  const panes = useMemo(() => {
    const points = new Map((query.data?.series ?? []).map((s) => [s.field, s.points ?? []]));
    const byUnit = new Map();
    for (const field of selected) {
      const unit = specs.get(field)?.unit ?? '';
      if (!byUnit.has(unit)) byUnit.set(unit, []);
      byUnit.get(unit).push({
        key: field,
        label: fieldLabel(field),
        color: seriesColor(slots.indexOf(field)),
        points: points.get(field) ?? [],
      });
    }
    return [...byUnit].map(([unit, series]) => ({
      unit,
      series,
      band: series.length === 1 ? bandOf(specs.get(series[0].key)) : null,
    }));
  }, [query.data, selected, slots, specs]);

  const data = query.data;
  const domain = data ? [toMs(data.start), toMs(data.stop)] : undefined;
  const empty = data && panes.every((p) => p.series.every((s) => !s.points.length));
  const options = GROUP_ORDER.map((group) => ({
    group,
    items: fields.filter((f) => fieldGroup(f.measurement) === group && !selected.includes(f.field)),
  })).filter((g) => g.items.length);

  return (
    <Card className={SERIES_VARS}>
      <CardHeader
        icon={ChartLine}
        title="Trends"
        subtitle={`Times in ${getFormatPrefs().timeZone}`}
        actions={<RangeSwitch value={range} onChange={setRange} />}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        {selected.map((field) => (
          <span
            key={field}
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-surface pr-1 pl-2.5 text-xs text-fg"
          >
            <span
              className="h-0.5 w-3 rounded-full"
              style={{ background: seriesColor(slots.indexOf(field)) }}
              aria-hidden
            />
            {fieldLabel(field)}
            <button
              type="button"
              onClick={() => remove(field)}
              aria-label={`Remove ${fieldLabel(field)}`}
              className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </span>
        ))}
        {selected.length < SERIES_MAX && options.length > 0 && (
          <Select
            aria-label="Add a parameter"
            value=""
            onChange={(e) => e.target.value && add(e.target.value)}
            className="h-8 w-auto text-xs"
          >
            <option value="">Add parameter…</option>
            {options.map(({ group, items }) => (
              <optgroup key={group} label={group}>
                {items.map((f) => (
                  <option key={f.field} value={f.field}>
                    {fieldLabel(f.field)}
                    {f.unit ? ` (${f.unit})` : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        )}
        {selected.length >= SERIES_MAX && (
          <span className="text-xs text-subtle">Up to {SERIES_MAX} parameters at a time</span>
        )}
      </div>

      <div className={cn('space-y-6 p-4 transition-opacity', query.isPlaceholderData && 'opacity-60')}>
        {!selected.length && (
          <p className="py-10 text-center text-sm text-muted">
            Pick a parameter above to see how it has changed.
          </p>
        )}
        {selected.length > 0 && query.isLoading && <Skeleton className="h-60 w-full" />}
        {query.isError && (
          <div className="flex flex-wrap items-center gap-3 py-6 text-sm text-critical">
            Couldn't load the trend: {query.error.message}
            <Button size="sm" onClick={() => query.refetch()}>
              Try again
            </Button>
          </div>
        )}
        {empty && (
          <p className="py-10 text-center text-sm text-muted">
            No readings in this period — the machine may have been switched off.
          </p>
        )}
        {data &&
          !empty &&
          selected.length > 0 &&
          panes.map((pane) => (
            <figure key={pane.unit || 'none'} className="m-0">
              <figcaption className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {pane.series.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5">
                    {pane.series.length > 1 && (
                      <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
                    )}
                    <span className="font-medium text-fg">{s.label}</span>
                    {s.points.length > 0 && (
                      <span className="text-muted tabular">
                        {formatValue(s.points[s.points.length - 1][1])} {pane.unit}
                      </span>
                    )}
                  </span>
                ))}
                {pane.band && (
                  <span className="inline-flex items-center gap-1.5 text-subtle">
                    <span className="size-2.5 rounded-sm bg-fg/10" aria-hidden />
                    Normal {bandText(pane.band, pane.unit)}
                  </span>
                )}
              </figcaption>
              <TelemetryChart
                series={pane.series}
                unit={pane.unit}
                band={pane.band}
                domain={domain}
                every={data.every}
                syncId={`trend-${assetId}`}
                height={panes.length === 1 ? 260 : 170}
              />
            </figure>
          ))}
      </div>

      {data && !empty && selected.length > 0 && (
        <details className="border-t border-border" onToggle={(e) => setShowTable(e.currentTarget.open)}>
          <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium text-muted hover:text-fg">
            Show the numbers as a table
          </summary>
          {showTable && <DataTable panes={panes} />}
        </details>
      )}
    </Card>
  );
};
