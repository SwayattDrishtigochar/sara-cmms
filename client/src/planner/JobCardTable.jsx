import { Clock, OctagonAlert, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { cn, formatNumber, formatTime } from '../lib/format.js';
import { Badge, Button } from '../ui/core.jsx';
import { Input, Select } from '../ui/form.jsx';
import { fromLocalDateTime, localDateTime } from './ganttLayout.js';
import { PersonSelect } from './PersonSelect.jsx';
import { operatorOf, operatorSkills, segmentsOf, withOperator } from './planEdits.js';
import { useBelowMd, useNarrow } from './useMedia.js';

const QUARTER = 15 * 60_000;
const humanize = (kind = '') => kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Issue chips of a row: kind as words, the full text on hover, severity by icon. */
export const IssueChips = ({ issues }) =>
  issues?.length ? (
    <ul className="flex flex-wrap gap-1" aria-label="Row issues">
      {issues.map((it, i) => (
        <li key={`${it.kind}-${i}`}>
          <Badge
            tone={it.severity === 'critical' ? 'critical' : 'warn'}
            className="max-w-full"
            title={it.text}
          >
            {it.severity === 'critical' ? (
              <OctagonAlert className="size-3" aria-hidden />
            ) : (
              <TriangleAlert className="size-3" aria-hidden />
            )}
            <span className="sr-only">{it.severity}: </span>
            {humanize(it.kind)}
          </Badge>
        </li>
      ))}
    </ul>
  ) : null;

/** Local-time `datetime-local` bound to an ISO value; an unparsable text leaves the value alone. */
export const TimeInput = ({ value, onChange, timeZone, ...props }) => (
  <Input
    type="datetime-local"
    value={localDateTime(value, timeZone)}
    onChange={(e) => {
      const ms = fromLocalDateTime(e.target.value, timeZone);
      if (ms != null) onChange(new Date(ms).toISOString());
    }}
    {...props}
  />
);

const HEAD = ['Machine', 'Mould', 'Start', 'End', 'Target', 'Operators', ''];
/** Below this width the table stacks into cards (the Planner's result column is narrower on most screens). */
const TABLE_MIN_PX = 1080;

/**
 * Editable job cards of a production plan. Per row: machine (limited to the mould's capable machines),
 * mould, start/end, target, one operator per shift segment, issue chips and the recomputed finish.
 * `parts` = useParts().parts, `machines` = Gantt rows `{ id, label, group }`, `shifts` = the plan's shifts.
 */
export const JobCardTable = ({
  edited,
  check,
  parts = [],
  machines = [],
  shifts = [],
  timeZone,
  plantId,
  plantLocked,
  onChange,
  onAdd,
  onRemove,
}) => {
  const [ref, narrow] = useNarrow(TABLE_MIN_PX);
  const below = useBelowMd() || narrow;
  const readOnly = !onChange;
  const part = parts.find((p) => p.partName === edited.partName);
  const byLabel = new Map(machines.map((m) => [m.label, m]));
  const byId = new Map(machines.map((m) => [m.id, m]));

  const rowOf = (card) => {
    const checked = (check?.jobCards ?? []).find((c) => c.key === card.key);
    const tool = part?.tools?.find((t) => t.id === card.toolId);
    const capable = (tool?.assets ?? [])
      .map((a) => (typeof a === 'object' ? (byId.get(a.id) ?? a) : byLabel.get(a)))
      .filter(Boolean);
    const options = capable.length ? capable : machines;
    const machine = byId.get(card.assetId);
    const segments = segmentsOf(shifts, card, timeZone);
    const issues = (checked?.issues ?? []).map((i) => check.issues?.[i]).filter(Boolean);
    const finishAt = checked?.finishAt;
    const late = finishAt && card.end && Date.parse(finishAt) - Date.parse(card.end) > QUARTER;
    const names = new Map((checked?.operators ?? []).map((o) => [o.userId, o.name]));
    const set = (patch) => onChange?.(card.key, patch);
    return {
      checked,
      issues,
      fields: [
        {
          label: 'Machine',
          node: (
            <Select
              aria-label={`Machine of ${card.key}`}
              value={card.assetId}
              onChange={(e) => set({ assetId: e.target.value })}
              disabled={readOnly}
              className="min-w-32"
            >
              {!options.some((m) => m.id === card.assetId) && (
                <option value={card.assetId}>
                  {machine?.label ?? checked?.asset ?? 'Choose a machine…'}
                </option>
              )}
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          ),
        },
        {
          label: 'Mould',
          node: (
            <span className="whitespace-nowrap text-sm text-fg">
              {tool?.toolNumber ?? checked?.tool ?? '—'}
              {checked?.setupMin > 0 && (
                <span className="block text-[11px] text-subtle">{checked.setupMin} min changeover</span>
              )}
            </span>
          ),
        },
        {
          label: 'Start',
          node: (
            <TimeInput
              aria-label={`Start of ${card.key}`}
              value={card.start}
              timeZone={timeZone}
              onChange={(start) => set({ start })}
              disabled={readOnly}
            />
          ),
        },
        {
          label: 'End',
          node: (
            <div>
              <TimeInput
                aria-label={`End of ${card.key}`}
                value={card.end}
                timeZone={timeZone}
                onChange={(end) => set({ end })}
                disabled={readOnly}
              />
              {late && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-warn">
                  <Clock className="size-3" aria-hidden />
                  Needs until {formatTime(finishAt)}
                </p>
              )}
            </div>
          ),
        },
        {
          label: 'Target',
          node: (
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              suffix="pcs"
              aria-label={`Target of ${card.key}`}
              value={card.target}
              onChange={(e) => set({ target: Number(e.target.value) })}
              disabled={readOnly}
              className="min-w-28"
            />
          ),
        },
        {
          label: 'Operators',
          node: (
            <ul className="space-y-1">
              {segments.map((seg) => {
                const current = operatorOf(card.operators, seg);
                return (
                  <li key={seg.start} className="flex items-center gap-1.5">
                    <span className="w-14 shrink-0 text-[11px] text-muted tabular">
                      {seg.name ? `Shift ${seg.name}` : formatTime(seg.start)}
                    </span>
                    {readOnly ? (
                      <span className="text-sm text-fg">
                        {(current && names.get(current.userId)) ?? 'Nobody'}
                      </span>
                    ) : (
                      <PersonSelect
                        aria-label={`Operator of ${card.key}${seg.name ? ` in shift ${seg.name}` : ''}`}
                        department="Production"
                        window={{ from: seg.start, to: seg.end }}
                        skills={operatorSkills(machine?.group)}
                        plantId={plantLocked ? undefined : plantId}
                        value={current?.userId ?? null}
                        label={current ? names.get(current.userId) : undefined}
                        onChange={(userId) => set({ operators: withOperator(card.operators, seg, userId) })}
                        disabled={readOnly}
                        className="min-w-36"
                      />
                    )}
                  </li>
                );
              })}
              {!segments.length && <li className="text-xs text-subtle">Set the window first</li>}
            </ul>
          ),
        },
        {
          label: '',
          node: onRemove ? (
            <Button
              size="iconSm"
              variant="ghost"
              aria-label={`Remove ${card.key}`}
              onClick={() => onRemove(card.key)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null,
        },
      ],
    };
  };

  const cards = edited.jobCards ?? [];
  const total = cards.reduce((s, c) => s + (Number(c.target) || 0), 0);
  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      <p className="text-xs text-muted tabular">
        {formatNumber(total)} of {formatNumber(edited.quantity)} pcs planned
        {total < edited.quantity && (
          <span className="text-warn"> · {formatNumber(edited.quantity - total)} short</span>
        )}
      </p>
      {onAdd && (
        <Button size="sm" icon={Plus} onClick={onAdd}>
          Add job card
        </Button>
      )}
    </div>
  );

  if (!cards.length) {
    return (
      <div>
        <p className="py-4 text-center text-sm text-muted">No job cards in this plan yet.</p>
        {footer}
      </div>
    );
  }

  if (below) {
    return (
      <div ref={ref}>
        <ul className="space-y-2" aria-label="Job cards">
          {cards.map((card) => {
            const row = rowOf(card);
            return (
              <li
                key={card.key}
                id={`row-${card.key}`}
                className={cn('rounded-lg border border-border p-3', row.issues.length && 'border-warn/50')}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold text-subtle tabular">{card.key}</span>
                  {row.fields[6].node}
                </div>
                <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                  {row.fields.slice(0, 6).map((f) => (
                    <div key={f.label} className="min-w-0">
                      <dt className="text-[11px] text-muted">{f.label}</dt>
                      <dd>{f.node}</dd>
                    </div>
                  ))}
                </dl>
                <IssueChips issues={row.issues} />
              </li>
            );
          })}
        </ul>
        {footer}
      </div>
    );
  }

  return (
    <div ref={ref}>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="text-left text-[11px] text-muted">
              {HEAD.map((h, i) => (
                <th key={h || i} scope="col" className="px-2 pb-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="align-top">
            {cards.map((card) => {
              const row = rowOf(card);
              return (
                <tr
                  key={card.key}
                  id={`row-${card.key}`}
                  className="border-t border-border target:bg-brand-soft"
                >
                  {row.fields.map((f, i) => (
                    <td key={f.label || i} className="px-2 py-2">
                      {f.node}
                      {i === 0 && <IssueChips issues={row.issues} />}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
};
