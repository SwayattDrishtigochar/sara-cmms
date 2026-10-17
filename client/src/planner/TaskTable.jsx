import { TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { cn, formatDateTime, formatMoney } from '../lib/format.js';
import { Badge } from '../ui/core.jsx';
import { Input } from '../ui/form.jsx';
import { IssueChips, TimeInput } from './JobCardTable.jsx';
import { PersonSelect } from './PersonSelect.jsx';
import { hoursText } from './PlanBlock.jsx';
import { skillsForTask } from './planEdits.js';
import { useBelowMd, useNarrow } from './useMedia.js';

const KIND = {
  workorder: { label: 'Work order', module: 'workorders' },
  pm: { label: 'PM', module: 'preventivemaintenances' },
  calibration: { label: 'Calibration', module: 'calibrations' },
  anomaly: { label: 'Anomaly' },
};
const linkOf = (t) =>
  t.kind === 'anomaly'
    ? `/anomalies?open=${t.refId}`
    : t.workOrderId
      ? `/m/workorders/${t.workOrderId}`
      : KIND[t.kind]?.module
        ? `/m/${KIND[t.kind].module}/${t.refId}`
        : null;

const HEAD = ['Task', 'Asset', 'Start', 'End', 'Duration', 'Technician', 'Impact', 'Deadline'];
/** Below this width the table stacks into cards (the Planner's result column is narrower on most screens). */
const TABLE_MIN_PX = 1080;

/**
 * Editable tasks of a maintenance plan (rows by key of `check.tasks`): window, duration, technician
 * (Maintenance people with the task's skills), impact chip, deadline with a late flag, issue chips.
 */
export const TaskTable = ({ edited, check, timeZone, plantId, onChange }) => {
  const [ref, narrow] = useNarrow(TABLE_MIN_PX);
  const below = useBelowMd() || narrow;
  const readOnly = !onChange;
  const meta = new Map((check?.tasks ?? []).map((t) => [t.key, t]));

  const rowOf = (row) => {
    const t = meta.get(row.key) ?? {};
    const issues = (t.issues ?? []).map((i) => check.issues?.[i]).filter(Boolean);
    const link = linkOf(t);
    const late = t.deadline && row.start && Date.parse(row.start) > Date.parse(t.deadline);
    const set = (patch) => onChange?.(row.key, patch);
    return {
      issues,
      fields: [
        {
          label: 'Task',
          node: (
            <div className="min-w-40">
              <p className="text-sm font-medium text-fg">{t.title ?? row.key}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                <Badge tone="neutral">{KIND[t.kind]?.label ?? t.kind ?? 'Task'}</Badge>
                {t.code &&
                  (link ? (
                    <Link to={link} className="font-medium text-brand hover:underline tabular">
                      {t.code}
                    </Link>
                  ) : (
                    <span className="tabular">{t.code}</span>
                  ))}
                {t.category && <span>{t.category}</span>}
              </p>
            </div>
          ),
        },
        { label: 'Asset', node: <span className="text-sm text-fg">{t.asset ?? '—'}</span> },
        {
          label: 'Start',
          node: (
            <TimeInput
              aria-label={`Start of ${t.title ?? row.key}`}
              value={row.start}
              timeZone={timeZone}
              onChange={(start) => set({ start })}
              disabled={readOnly}
            />
          ),
        },
        {
          label: 'End',
          node: (
            <TimeInput
              aria-label={`End of ${t.title ?? row.key}`}
              value={row.end}
              timeZone={timeZone}
              onChange={(end) => set({ end })}
              disabled={readOnly}
            />
          ),
        },
        {
          label: 'Duration',
          node: (
            <Input
              type="number"
              inputMode="numeric"
              min={5}
              step={5}
              suffix="min"
              aria-label={`Duration of ${t.title ?? row.key}`}
              value={row.durationMin ?? ''}
              onChange={(e) => set({ durationMin: Number(e.target.value) })}
              disabled={readOnly}
              className="min-w-24"
            />
          ),
        },
        {
          label: 'Technician',
          // A plan that can't change any more names its technician (the picker would call them busy with it).
          node: readOnly ? (
            <span className="text-sm text-fg">{t.technician?.name ?? 'Nobody'}</span>
          ) : (
            <PersonSelect
              aria-label={`Technician of ${t.title ?? row.key}`}
              department="Maintenance"
              window={{ from: row.start, to: row.end }}
              skills={skillsForTask(t)}
              plantId={plantId}
              value={row.technicianId}
              label={t.technician?.name}
              onChange={(technicianId) => set({ technicianId })}
              disabled={readOnly}
              className="min-w-40"
            />
          ),
        },
        {
          label: 'Impact',
          node:
            t.zeroImpact || !t.impactHours ? (
              <Badge tone="success">No impact</Badge>
            ) : (
              <Badge tone="warn" className="tabular">
                {hoursText(t.impactHours)} · {formatMoney(t.impactCost ?? 0)}
              </Badge>
            ),
        },
        {
          label: 'Deadline',
          node: (
            <span className={cn('text-xs tabular', late ? 'font-medium text-critical' : 'text-muted')}>
              {late && <TriangleAlert className="mr-1 inline size-3" aria-label="Late" />}
              {t.deadline ? formatDateTime(t.deadline) : '—'}
              {late && <span className="block">after its deadline</span>}
            </span>
          ),
        },
      ],
    };
  };

  const rows = edited.tasks ?? [];
  if (!rows.length) return <p className="py-4 text-center text-sm text-muted">No tasks in this plan.</p>;

  if (below) {
    return (
      <ul ref={ref} className="space-y-2" aria-label="Maintenance tasks">
        {rows.map((row) => {
          const r = rowOf(row);
          return (
            <li
              key={row.key}
              id={`row-${row.key}`}
              className={cn('rounded-lg border border-border p-3', r.issues.length && 'border-warn/50')}
            >
              <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                {r.fields.map((f) => (
                  <div key={f.label} className="min-w-0">
                    <dt className="text-[11px] text-muted">{f.label}</dt>
                    <dd>{f.node}</dd>
                  </div>
                ))}
              </dl>
              <IssueChips issues={r.issues} />
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div ref={ref} className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[1000px] text-sm">
        <thead>
          <tr className="text-left text-[11px] text-muted">
            {HEAD.map((h) => (
              <th key={h} scope="col" className="px-2 pb-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="align-top">
          {rows.map((row) => {
            const r = rowOf(row);
            return (
              <tr key={row.key} id={`row-${row.key}`} className="border-t border-border target:bg-brand-soft">
                {r.fields.map((f, i) => (
                  <td key={f.label} className="px-2 py-2">
                    {f.node}
                    {i === 0 && <IssueChips issues={r.issues} />}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
