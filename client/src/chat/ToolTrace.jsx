import { ChevronRight, CircleAlert, CircleCheck, Loader2, ShieldQuestion, Wrench } from 'lucide-react';
import { useState } from 'react';
import { cn, formatNumber } from '../lib/format.js';
import { useModulesMeta } from '../modules/useModules.js';
import { humanize, plural } from '../superadmin/simUtils.js';

const VERBS = {
  mongo_find: 'Queried',
  mongo_count: 'Counted',
  mongo_distinct: 'Listed values of',
  mongo_aggregate: 'Analysed',
  module_schema: 'Read the fields of',
  create_record: 'Create',
  update_record: 'Update',
  delete_record: 'Delete',
};
const LABELS = {
  resolve_time_range: 'Worked out the time range',
  render_table: 'Built a table',
  render_chart: 'Drew a chart',
  render_kpis: 'Built KPI tiles',
  export_csv: 'Prepared a CSV file',
  load_tools: 'Loaded more skills',
  telemetry_fields: 'Listed machine parameters',
  telemetry_latest: 'Read live machine values',
  telemetry_series: 'Read machine trends',
  telemetry_status_timeline: 'Read the status timeline',
  telemetry_shot_counts: 'Counted shots',
  energy_consumption: 'Calculated energy use',
  influx_flux: 'Ran a telemetry query',
  machine_health: 'Checked machine health',
  list_anomalies: 'Listed anomalies',
  work_orders_summary: 'Summarised work orders',
  spare_parts_below_minimum: 'Checked stock levels',
  upcoming_maintenance: 'Checked upcoming maintenance',
  job_card_progress: 'Checked job card progress',
  rejection_summary: 'Summarised rejections',
  downtime_summary: 'Summarised downtime',
  attendance_summary: 'Checked attendance',
  update_work_order_status: 'Change a work order status',
  add_work_order_comment: 'Comment on a work order',
};

/** Human line for one tool call, e.g. "Queried work orders" or "Looked up asset "Press 1"". */
export const toolLabel = (name, args = {}, moduleLabel = humanize) => {
  if (VERBS[name])
    return `${VERBS[name]} ${args.module ? moduleLabel(args.module).toLowerCase() : 'records'}`;
  if (name === 'resolve')
    return `Looked up ${humanize(args.kind ?? 'record').toLowerCase()} "${args.query ?? ''}"`;
  return LABELS[name] ?? humanize(name);
};

/** "23 rows · 120 ms" for a finished call. */
export const resultText = (result) =>
  [
    result?.summary,
    result?.rowCount != null &&
      !String(result.summary ?? '').includes(String(result.rowCount)) &&
      plural(result.rowCount, 'row'),
    result?.ms != null && `${formatNumber(result.ms, { digits: 0 })} ms`,
  ]
    .filter(Boolean)
    .join(' · ');

const isFailed = (result) => Boolean(result && (result.ok === false || result.error));

/** A step with no result yet: running while the turn streams, waiting while a write awaits Confirm. */
const stateOf = (result, { streaming, awaiting }) => {
  if (result) return isFailed(result) ? 'failed' : 'done';
  if (awaiting) return 'waiting';
  return streaming ? 'running' : 'stopped';
};
const STATE = {
  done: { icon: CircleCheck, label: 'Done', className: 'text-success' },
  failed: { icon: CircleAlert, label: 'Failed', className: 'text-critical' },
  running: { icon: Loader2, label: 'Running', className: 'animate-spin text-muted' },
  waiting: { icon: ShieldQuestion, label: 'Waiting for your confirmation', className: 'text-warn' },
  stopped: { icon: CircleAlert, label: 'Not finished', className: 'text-subtle' },
};

const Step = ({ call, result, moduleLabel, state }) => {
  const [open, setOpen] = useState(false);
  const s = STATE[state];
  const detail =
    state === 'failed'
      ? (result.error ?? 'failed')
      : state === 'waiting'
        ? 'waiting for your confirmation'
        : result && resultText(result);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors duration-150 hover:bg-surface-2"
      >
        <s.icon className={cn('size-3.5 shrink-0', s.className)} aria-label={s.label} />
        <span
          className={cn(
            'min-w-0 shrink-0 truncate font-medium',
            state === 'failed' ? 'text-critical' : 'text-fg',
          )}
        >
          {toolLabel(call.name, call.args, moduleLabel)}
        </span>
        {detail && <span className="min-w-0 truncate text-subtle tabular">· {detail}</span>}
        <ChevronRight
          className={cn(
            'ml-auto size-3 shrink-0 text-subtle transition-transform duration-150',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <div className="mb-1 ml-6 space-y-1 text-[11px]">
          <p className="font-mono text-subtle">{call.name}</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-muted scrollbar-thin">
            {JSON.stringify(call.args ?? {}, null, 2)}
          </pre>
          {state === 'failed' && result.error && <p className="text-critical">{result.error}</p>}
        </div>
      )}
    </li>
  );
};

/**
 * The tools a turn used: `steps` = [{ call, result? }]. Open while the turn streams, one quiet summary line
 * once it is done; each row expands to show its arguments. `awaiting`: a write waits for Confirm.
 */
export const ToolTrace = ({ steps, streaming, awaiting }) => {
  const [open, setOpen] = useState(null);
  const { data: modules } = useModulesMeta();
  const moduleLabel = (name) => modules?.find((m) => m.name === name)?.label ?? humanize(name);
  const states = steps.map((s) => stateOf(s.result, { streaming, awaiting }));
  const failed = states.filter((s) => s === 'failed').length;
  const ms = steps.reduce((t, s) => t + (s.result?.ms ?? 0), 0);
  const running = states.lastIndexOf('running');
  const isOpen = open ?? streaming;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!isOpen)}
        aria-expanded={isOpen}
        className="-ml-1.5 flex h-7 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-fg"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform duration-150', isOpen && 'rotate-90')}
          aria-hidden
        />
        <Wrench className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate font-medium">
          {running >= 0
            ? `${toolLabel(steps[running].call.name, steps[running].call.args, moduleLabel)}…`
            : `Used ${plural(steps.length, 'tool')}`}
        </span>
        {failed > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-critical">
            <CircleAlert className="size-3" aria-hidden /> {failed} failed
          </span>
        )}
        {ms > 0 && running < 0 && (
          <span className="shrink-0 text-subtle tabular">· {formatNumber(ms / 1000, { digits: 1 })} s</span>
        )}
      </button>
      {isOpen && (
        <ul className="mt-0.5 ml-[11px] border-l border-border pl-2.5 animate-fade-in">
          {steps.map((s, i) => (
            <Step
              key={s.call.id ?? i}
              call={s.call}
              result={s.result}
              moduleLabel={moduleLabel}
              state={states[i]}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
