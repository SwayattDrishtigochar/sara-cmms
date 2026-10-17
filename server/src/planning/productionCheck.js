import { z } from 'zod';
import { plantOf, zoneOf } from '../agent/tools/common.js';
import { AiUnavailableError } from '../ai/gemini.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { escapeRegex } from '../lib/format.js';
import { logger } from '../lib/logger.js';
import { OBJECT_ID_PATTERN } from '../modules/fields.js';
import { scopeFilter } from '../modules/records.js';
import { getModule } from '../modules/registry.js';
import { assertPlanDates, buildCalendar } from './capacity.js';
import { feasibilityText } from './explain.js';
import { advanceWorking, subtractIntervals } from './intervals.js';
import { bookPerson, freeFor, loadPeople, pickPerson, shiftSegments } from './people.js';
import {
  canPlanProduction,
  cardRisks,
  cut,
  fitByDue,
  fmt,
  HOUR,
  historicalRejection,
  jobCardOp,
  lateIssue,
  pcs,
  planOp,
  planTitle,
  same,
  trimTargets,
  verdictOf,
} from './production.js';
import { operatorMissing, skillsFor } from './productionOperators.js';
import { getProposal, toPlanBlock } from './proposals.js';

/**
 * Production plan check (phase 7 §3.3): the user-edited plan → issues (machine, mould, working time,
 * duration, due date, quantity, operators), concrete adjustments with patches, the verdict, ghost bars;
 * with a proposalId the proposal's ops/diff are rewritten and the AI explanation stored.
 */

const DAY = 24 * HOUR;
const TOLERANCE = 15 * 60_000;
const ms = (d) => new Date(d).getTime();
const r1 = (n) => Math.round(n * 10) / 10;
const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
const overlaps = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
const inside = (list, at) => list.some((i) => ms(i.start) <= ms(at) && ms(at) < ms(i.end));
const iso = (d) => (d == null ? undefined : new Date(d).toISOString());

const objectId = z.string().regex(OBJECT_ID_PATTERN, 'must be a record id');
const isoDate = z.iso.datetime({ offset: true });
const operatorSchema = z.object({
  userId: objectId,
  shiftName: z.string().max(40).optional(),
  start: isoDate.optional(),
  end: isoDate.optional(),
});
/** EditedProductionPlan over the wire (§3.3). */
export const editedPlanSchema = z.object({
  proposalId: z.string().min(1).max(60).optional(),
  partName: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().min(1).max(10_000_000),
  dueDate: isoDate,
  plantId: objectId.optional(),
  customerId: objectId.optional(),
  rejectionPct: z.number().min(0).max(50).optional(),
  jobCards: z
    .array(
      z.object({
        key: z.string().min(1).max(20),
        assetId: objectId,
        toolId: objectId,
        target: z.coerce.number().int().min(1).max(10_000_000),
        start: isoDate,
        end: isoDate,
        operators: z.array(operatorSchema).max(6).default([]),
      }),
    )
    .min(1)
    .max(10),
});

/** The stored plan of a production proposal as an EditedProductionPlan (the chat tool edits this). */
export const editedFromProposal = (p) => {
  const base = p.input?.edited ?? p.input ?? {};
  return {
    proposalId: String(p._id),
    partName: base.partName,
    quantity: base.quantity,
    dueDate: iso(base.dueDate),
    ...(p.plantId ? { plantId: String(p.plantId) } : {}),
    ...(base.customerId ? { customerId: String(base.customerId) } : {}),
    ...(base.rejectionPct != null ? { rejectionPct: base.rejectionPct } : {}),
    jobCards: (p.diff?.jobCards ?? []).map((j) => ({
      key: j.key,
      assetId: String(j.assetId),
      toolId: String(j.toolId),
      target: j.target,
      start: iso(j.start),
      end: iso(j.end),
      operators: (j.operators ?? []).map((o) => ({
        userId: String(o.userId),
        shiftName: o.shiftName,
        start: iso(o.start),
        end: iso(o.end),
      })),
    })),
  };
};

/** Operators listed for a card → one per shift segment: same start first, then shift name, then order. */
const operatorsBySegment = (listed, segments) => {
  const left = [...listed];
  const out = segments.map(() => null);
  const pass = (pred) => {
    segments.forEach((seg, i) => {
      if (out[i]) return;
      const j = left.findIndex((o) => pred(o, seg));
      if (j !== -1) out[i] = left.splice(j, 1)[0];
    });
  };
  pass((o, seg) => o.start && ms(o.start) === ms(seg.start));
  pass((o, seg) => o.shiftName && o.shiftName === seg.shiftName);
  pass((o) => !o.start && !o.shiftName);
  return out;
};

/** Best suggestion first: most critical issues resolved, then most issues; ids renumbered (in place). */
export const rankAdjustments = (issues, adjustments) => {
  const critical = (a) => a.resolves.filter((i) => issues[i]?.severity === 'critical').length;
  adjustments.sort((a, b) => critical(b) - critical(a) || b.resolves.length - a.resolves.length);
  adjustments.forEach((a, n) => {
    a.id = `adj-${n + 1}`;
  });
  return adjustments;
};

/**
 * Pure check of an edited plan against a calendar and a roster.
 * @param {{ plant, zone, people, excludeIds?: Set<string>, rejectionRate?: number }} opts excludeIds = job
 *   cards already applied by the proposal being edited (their bookings are the plan's own); rejectionRate =
 *   the planner's rate (0–1) when the user typed none, else 2 %
 */
export const checkPlan = (cal, edited, { plant, zone, people, excludeIds = new Set(), rejectionRate }) => {
  const quantity = Math.round(edited.quantity);
  const dueDate = new Date(edited.dueDate);
  const r = Math.min(
    0.5,
    Math.max(0, edited.rejectionPct != null ? edited.rejectionPct / 100 : (rejectionRate ?? 0.02)),
  );
  const machinesById = new Map(cal.machines.map((m) => [m.assetId, m]));
  const toolsById = new Map(cal.tools.map((t) => [t.toolId, t]));
  const issues = [];
  const adjustments = [];
  const cards = edited.jobCards
    .map((c) => ({
      key: c.key,
      assetId: String(c.assetId),
      toolId: String(c.toolId),
      target: Math.round(c.target),
      start: new Date(c.start),
      end: new Date(c.end),
      listed: c.operators ?? [],
      operators: [],
      issues: [],
      shifts: 0,
    }))
    .sort((a, b) => ms(a.start) - ms(b.start));
  const issue = (card, x) => {
    const i =
      issues.push({
        severity: 'warning',
        ...x,
        text: cut(x.text),
        jobCard: card?.key,
        assetId: card?.assetId,
      }) - 1;
    card?.issues.push(i);
    return i;
  };
  const adjust = (x) => adjustments.push({ id: `adj-${adjustments.length + 1}`, ...x });
  const cardLabel = (card) => `the ${machinesById.get(card.assetId)?.name ?? card.key} card`;

  const bookingsOf = (m) => m.bookings.filter((b) => !excludeIds.has(b.id));
  const others = (card) => cards.filter((c) => c !== card);
  /** Everything a card may not overlap on machine m with tool t: bookings, the mould elsewhere, other edited cards. */
  const blockedFor = (card, m, t) => [
    ...bookingsOf(m),
    ...t.busy.filter((b) => b.assetId !== m.assetId && !excludeIds.has(b.jobCardId)),
    ...others(card).filter((c) => c.assetId === m.assetId || c.toolId === t.toolId),
  ];
  /** What a card may not span: as blockedFor, but a planned work order is run around (it pauses the card), as the planner does. */
  const clashesFor = (card, m, t) => blockedFor(card, m, t).filter((b) => b.kind !== 'workorder');
  const shotsOf = (card, t, target = card.target) => {
    const part = t.parts.find((p) => same(p.partName, edited.partName));
    return Math.ceil(target / (1 - r) / (part?.perShot || 1));
  };
  /** Setup only when the mould on the machine's last card before `start` differs (edited cards count). */
  const setupSecFor = (card, m, t, start) => {
    const last = [
      ...bookingsOf(m).filter((b) => b.kind === 'jobcard'),
      ...others(card).filter((c) => c.assetId === m.assetId),
    ]
      .filter((b) => ms(b.end) <= ms(start))
      .reduce((a, b) => (!a || ms(b.end) > ms(a.end) ? b : a), null);
    const mounted = last ? last.toolId : m.mountedToolId;
    return mounted === t.toolId ? 0 : t.setupMin * 60;
  };
  const secondsFor = (card, m, t, start, target) =>
    setupSecFor(card, m, t, start) + (shotsOf(card, t, target) * t.cycleSec) / m.efficiency;
  const availFor = (card, m, t) => subtractIntervals(m.working, blockedFor(card, m, t));
  const finishFrom = (card, m, t, from, target) =>
    advanceWorking(availFor(card, m, t), from, secondsFor(card, m, t, from, target))?.end ?? null;
  /** When `target` parts of the card are done from its start on its own machine (null: incapable or never). */
  const finishFor = (card, target) => {
    const m = machinesById.get(card.assetId);
    const t = toolsById.get(card.toolId);
    return m && t?.parts.some((p) => same(p.partName, edited.partName))
      ? finishFrom(card, m, t, card.start, target)
      : null;
  };
  /** The first start ≥ `from` on m where the whole card fits before the next job card, with its end. */
  const firstFit = (card, m, t, from) => {
    const avail = availFor(card, m, t);
    const blocked = clashesFor(card, m, t);
    const starts = [from, ...avail.map((i) => i.start).filter((s) => ms(s) > ms(from))];
    for (const s of starts) {
      if (!inside(avail, s)) continue;
      const end = finishFrom(card, m, t, s);
      if (end && !blocked.some((b) => overlaps(b, { start: s, end }))) return { start: s, end };
    }
    return null;
  };
  /** Operators for a card moved to `window` on m: listed ones kept when still free, gaps filled. */
  const operatorsFor = (card, m, window) => {
    if (!plant) return undefined;
    const roster = structuredClone(people);
    const byId = new Map(roster.map((p) => [p.userId, p]));
    for (const o of others(card).flatMap((c) => c.listed)) {
      const p = o.start && o.end ? byId.get(String(o.userId)) : null;
      if (p) bookPerson(p, { kind: 'jobcard', id: 'plan', code: 'plan', start: o.start, end: o.end });
    }
    const segments = shiftSegments(plant, window, zone);
    const listed = operatorsBySegment(card.listed, segments);
    const skills = skillsFor(m);
    return segments
      .map((seg, i) => {
        const kept = listed[i] ? byId.get(String(listed[i].userId)) : null;
        const p = kept && freeFor(kept, seg) ? kept : pickPerson(roster, seg, { skills });
        if (!p) return null;
        bookPerson(p, { kind: 'jobcard', id: card.key, code: card.key, start: seg.start, end: seg.end });
        return { userId: p.userId, shiftName: seg.shiftName, start: iso(seg.start), end: iso(seg.end) };
      })
      .filter(Boolean);
  };
  const movePatch = (card, m, fit) => ({
    jobCards: [
      {
        key: card.key,
        ...(m.assetId !== card.assetId ? { assetId: m.assetId } : {}),
        start: iso(fit.start),
        end: iso(fit.end),
        operators: operatorsFor(card, m, fit),
      },
    ],
  });
  const moveMachine = (card, t, from) => {
    let best = null;
    for (const id of t.assets) {
      const m2 = machinesById.get(id);
      if (!m2 || id === card.assetId) continue;
      if (m2.openAnomalies.some((a) => a.severity === 'critical')) continue;
      const fit = firstFit(card, m2, t, from);
      if (fit && (!best || ms(fit.start) < ms(best.fit.start))) best = { m2, fit };
    }
    return best;
  };

  for (const card of cards) {
    const t = toolsById.get(card.toolId);
    const m = machinesById.get(card.assetId);
    card.finishAt = card.end;
    card.setupMin = 0;
    card.shots = 0;
    if (!t?.parts.some((p) => same(p.partName, edited.partName))) {
      issue(card, {
        kind: 'tool_incapable',
        severity: 'critical',
        text: t
          ? `${t.toolNumber ?? t.name} does not make ${edited.partName}`
          : `The mould of ${cardLabel(card)} was not found`,
      });
      continue;
    }
    card.shots = shotsOf(card, t);
    const placement = [];
    if (!m || !t.assets.includes(card.assetId)) {
      placement.push(
        issue(card, {
          kind: 'machine_incapable',
          severity: 'critical',
          text: m
            ? `${t.toolNumber ?? t.name} cannot run on ${m.name}`
            : `The machine of ${cardLabel(card)} is not in this plan's plant`,
        }),
      );
      const alt = moveMachine(card, t, card.start);
      if (alt) {
        adjust({
          kind: 'move_machine',
          label: `Move ${cardLabel(card)} to ${alt.m2.name} from ${fmt(cal, alt.fit.start, true)}`,
          patch: movePatch(card, alt.m2, alt.fit),
          resolves: [...placement],
        });
      }
      continue;
    }
    card.setupMin = setupSecFor(card, m, t, card.start) / 60;
    const window = { start: card.start, end: card.end };
    // Job cards clash; a planned work order inside the window only pauses the card (finishAt includes it).
    const clash = [
      ...bookingsOf(m).filter((b) => b.kind !== 'workorder'),
      ...others(card).filter((c) => c.assetId === m.assetId),
    ].filter((b) => overlaps(b, window));
    if (clash.length) {
      placement.push(
        issue(card, {
          kind: 'machine_overlap',
          severity: 'critical',
          text: `${m.name} is busy with ${clash.map((b) => b.code ?? b.key).join(', ')} until ${fmt(cal, new Date(Math.max(...clash.map((b) => ms(b.end)))), true)}`,
        }),
      );
    }
    const toolClash = [
      ...t.busy.filter((b) => b.assetId !== m.assetId && !excludeIds.has(b.jobCardId)),
      ...others(card).filter((c) => c.toolId === t.toolId && c.assetId !== m.assetId),
    ].filter((b) => overlaps(b, window));
    if (toolClash.length) {
      const other = machinesById.get(toolClash[0].assetId)?.name ?? 'another machine';
      placement.push(
        issue(card, {
          kind: 'tool_overlap',
          severity: 'critical',
          text: `${t.toolNumber ?? t.name} runs on ${other} until ${fmt(cal, new Date(Math.max(...toolClash.map((b) => ms(b.end)))), true)}`,
        }),
      );
    }
    let from = card.start;
    if (!inside(m.working, card.start)) {
      placement.push(
        issue(card, {
          kind: 'outside_working',
          severity: 'critical',
          text: `${m.name} is not working at ${fmt(cal, card.start, true)}`,
        }),
      );
      from = m.working.find((i) => ms(i.end) > ms(card.start))?.start ?? card.start;
    }
    const finishAt = finishFrom(card, m, t, card.start);
    if (!finishAt) {
      issue(card, {
        kind: 'too_short',
        severity: 'critical',
        text: `${cardLabel(card)} does not fit in the planning horizon`,
      });
    } else {
      card.finishAt = finishAt;
      if (ms(card.end) < ms(finishAt) - TOLERANCE) {
        const i = issue(card, {
          kind: 'too_short',
          severity: 'critical',
          text: `${pcs(card.target)} pcs on ${m.name} need until ${fmt(cal, finishAt, true)}, not ${fmt(cal, card.end, true)}`,
        });
        adjust({
          kind: 'move_end',
          label: `End ${cardLabel(card)} at ${fmt(cal, finishAt, true)}`,
          patch: { jobCards: [{ key: card.key, end: iso(finishAt) }] },
          resolves: [i],
        });
      }
    }
    if (placement.length) {
      const fit = firstFit(card, m, t, from);
      if (fit) {
        adjust({
          kind: 'move_start',
          label: `Start ${cardLabel(card)} at ${fmt(cal, fit.start, true)}`,
          patch: movePatch(card, m, fit),
          resolves: [...placement, ...card.issues.filter((i) => issues[i].kind === 'too_short')],
        });
      }
      const alt = moveMachine(card, t, card.start);
      if (alt) {
        adjust({
          kind: 'move_machine',
          label: `Move ${cardLabel(card)} to ${alt.m2.name} from ${fmt(cal, alt.fit.start, true)}`,
          patch: movePatch(card, alt.m2, alt.fit),
          resolves: [...placement, ...card.issues.filter((i) => issues[i].kind === 'too_short')],
        });
      }
    }
    const critical = m.openAnomalies.find((a) => a.severity === 'critical');
    if (critical) {
      const i = issue(card, {
        kind: 'anomaly',
        text: `${critical.code} (${critical.summary ?? critical.type}) is open on ${m.name}`,
      });
      const alt = moveMachine(card, t, card.start);
      if (alt) {
        adjust({
          kind: 'move_machine',
          label: `Move ${cardLabel(card)} to ${alt.m2.name} from ${fmt(cal, alt.fit.start, true)}`,
          patch: movePatch(card, alt.m2, alt.fit),
          resolves: [i],
        });
      }
    }
  }

  // Plan level: due date and quantity.
  const effectiveEnd = (c) => new Date(Math.max(ms(c.end), ms(c.finishAt)));
  const projectedFinish = new Date(Math.max(...cards.map((c) => ms(effectiveEnd(c)))));
  const feasible = ms(projectedFinish) <= ms(dueDate);
  const slackHours = r1((ms(dueDate) - ms(projectedFinish)) / HOUR);
  // What each card makes by the due date (and where it then ends): the shortfall and reduce_quantity's patch.
  const byDue = feasible ? [] : fitByDue(cards, dueDate, finishFor);
  const doneByDue = sum(byDue, (x) => x.target);
  const shortfall = feasible ? 0 : Math.max(0, quantity - doneByDue);
  const notes = feasible
    ? `On time: finishes ${fmt(cal, projectedFinish, true)}, ${slackHours} h before the due date`
    : `Late: ${pcs(shortfall)} pcs short on ${fmt(cal, dueDate)}; all parts done by ${fmt(cal, projectedFinish, true)}`;
  if (!feasible) lateIssue(cal, { issues, adjustments, notes, projectedFinish, byDue, jobCards: cards });
  const total = sum(cards, (c) => c.target);
  if (total < quantity) {
    const i = issue(null, {
      kind: 'short',
      severity: 'critical',
      text: `The job cards make ${pcs(total)} of ${pcs(quantity)} pcs`,
    });
    const largest = cards.reduce((a, b) => (b.target > a.target ? b : a));
    adjust({
      kind: 'fill_quantity',
      label: `Add ${pcs(quantity - total)} pcs to ${cardLabel(largest)}`,
      patch: { jobCards: [{ key: largest.key, target: largest.target + quantity - total }] },
      resolves: [i],
    });
  } else if (total > quantity * 1.02) {
    const i = issue(null, {
      kind: 'over_quantity',
      text: `The job cards make ${pcs(total)} pcs for an order of ${pcs(quantity)}`,
    });
    adjust({
      kind: 'reduce_quantity',
      label: `Trim the job cards to ${pcs(quantity)} pcs`,
      patch: { jobCards: trimTargets(cards, quantity, finishFor) },
      resolves: [i],
    });
  }

  // Operators: one per shift segment, on shift and free (bookings grow as the plan is walked).
  const roster = structuredClone(people);
  const byId = new Map(roster.map((p) => [p.userId, p]));
  const suggested = []; // picks already offered to the user, so two suggestions never name one person at once
  for (const card of cards) {
    const m = machinesById.get(card.assetId);
    if (!m || !plant) continue;
    const segments = shiftSegments(plant, { start: card.start, end: card.end }, zone);
    card.shifts = segments.length;
    const skills = skillsFor(m);
    const listed = operatorsBySegment(card.listed, segments);
    const rows = segments.map((seg, i) => ({ seg, userId: listed[i]?.userId ?? null }));
    const operatorsPatch = () => ({
      jobCards: [
        {
          key: card.key,
          operators: rows
            .filter((x) => x.userId)
            .map((x) => ({
              userId: x.userId,
              shiftName: x.seg.shiftName,
              start: iso(x.seg.start),
              end: iso(x.seg.end),
            })),
        },
      ],
    });
    for (const row of rows) {
      const { seg } = row;
      const person = row.userId ? byId.get(row.userId) : null;
      const onShift = person && freeFor({ ...person, bookings: [] }, seg);
      const free = person && freeFor(person, seg);
      if (person && free) {
        bookPerson(person, { kind: 'jobcard', id: card.key, code: card.key, start: seg.start, end: seg.end });
        card.operators.push({
          userId: person.userId,
          name: person.name,
          shiftId: seg.shiftId ?? null,
          shiftName: seg.shiftName,
          start: seg.start,
          end: seg.end,
        });
        continue;
      }
      const day = fmt(cal, seg.start);
      const i = !row.userId
        ? issue(card, operatorMissing(card, m, seg, { zone, dateFormat: cal.dateFormat }))
        : !person || !onShift
          ? issue(card, {
              kind: 'operator_off_shift',
              text: `${person?.name ?? 'The operator'} is not on shift ${seg.shiftName} on ${day}`,
              userId: row.userId,
            })
          : issue(card, {
              kind: 'operator_busy',
              text: `${person.name} is already on ${person.bookings.find((b) => overlaps(b, seg))?.code ?? 'another job'} in shift ${seg.shiftName} on ${day}`,
              userId: row.userId,
            });
      if (person) {
        card.operators.push({
          userId: person.userId,
          name: person.name,
          shiftId: seg.shiftId ?? null,
          shiftName: seg.shiftName,
          start: seg.start,
          end: seg.end,
        });
      }
      const exclude = new Set([
        ...(row.userId ? [row.userId] : []),
        ...suggested.filter((x) => overlaps(x, seg)).map((x) => x.userId),
      ]);
      const pick = pickPerson(roster, seg, { skills, exclude });
      if (!pick) continue;
      suggested.push({ userId: pick.userId, start: seg.start, end: seg.end });
      const was = row.userId;
      row.userId = pick.userId;
      adjust({
        kind: was ? 'swap_operator' : 'assign_operator',
        label: was
          ? `Put ${pick.name} instead of ${person?.name ?? 'the operator'} on ${m.name} for shift ${seg.shiftName} on ${day}`
          : `Assign ${pick.name} to ${m.name} for shift ${seg.shiftName} on ${day}`,
        patch: operatorsPatch(),
        resolves: [i],
      });
    }
  }

  rankAdjustments(issues, adjustments);
  const verdict = verdictOf(issues, adjustments);
  const risks = cards.flatMap((c) => {
    const m = machinesById.get(c.assetId);
    const t = toolsById.get(c.toolId);
    return m && t ? cardRisks(cal, { machine: m, tool: t, start: c.start, end: c.end, shots: c.shots }) : [];
  });
  const bars = cards.flatMap((c) => {
    const m = machinesById.get(c.assetId);
    const t = toolsById.get(c.toolId);
    const conflict = c.issues.some((i) => issues[i].severity === 'critical');
    const setupEnd = c.setupMin > 0 && m ? advanceWorking(m.working, c.start, c.setupMin * 60)?.end : null;
    const names = [...new Set(c.operators.map((o) => o.name))];
    return [
      ...(setupEnd
        ? [
            {
              id: `${c.key}-setup`,
              rowId: c.assetId,
              start: c.start,
              end: setupEnd,
              label: `Changeover to ${t?.toolNumber ?? t?.name ?? 'the mould'}`,
              kind: 'setup',
              ghost: true,
              change: 'new',
            },
          ]
        : []),
      {
        id: c.key,
        rowId: c.assetId,
        start: c.start,
        end: c.end,
        label: `${edited.partName} · ${pcs(c.target)} pcs`,
        kind: 'jobcard',
        ghost: true,
        change: 'new',
        ...(conflict ? { conflict: true } : {}),
        ...(ms(effectiveEnd(c)) > ms(dueDate) ? { late: true } : {}),
        tooltip: `${t?.toolNumber ?? t?.name ?? ''} · ${pcs(c.target)} pcs${names.length ? ` · ${names.join(', ')}` : ''}`,
      },
    ];
  });
  return {
    verdict,
    feasibility: {
      feasible,
      verdict,
      dueDate,
      projectedFinish,
      slackHours,
      shortfall,
      notes,
      issues,
      adjustments,
    },
    issues,
    adjustments,
    jobCards: cards.map((c) => {
      const m = machinesById.get(c.assetId);
      const t = toolsById.get(c.toolId);
      return {
        key: c.key,
        assetId: c.assetId,
        asset: m?.name ?? null,
        toolId: c.toolId,
        tool: t ? (t.toolNumber ?? t.name) : null,
        target: c.target,
        start: c.start,
        end: c.end,
        finishAt: c.finishAt,
        setupMin: c.setupMin,
        shots: c.shots,
        shifts: c.shifts,
        operators: c.operators,
        issues: c.issues,
      };
    }),
    risks,
    bars,
    rejectionRate: r,
  };
};

/** Machines that can run a mould of the part (for the calendar and `move_machine`). */
const capableMachines = async (ctx, partName) => {
  const mod = getModule('tools');
  const tools = await mod.Model.find({
    ...scopeFilter(ctx, mod),
    'mouldParts.partName': { $regex: `^${escapeRegex(partName.trim())}$`, $options: 'i' },
  })
    .select('assets')
    .lean();
  return tools.flatMap((t) => (t.assets ?? []).map(String));
};

/**
 * Loads the calendar and the roster, checks the edited plan, draws its ghost bars, rewrites the proposal
 * (when `proposalId`) and asks for the `plan_feasibility` explanation (AI failure → `explanation: null`).
 */
export const checkProductionPlan = async (ctx, edited, { now = new Date() } = {}) => {
  if (!canPlanProduction(ctx))
    throw forbidden('Your role or company plan does not allow production planning');
  const proposal = edited.proposalId ? await getProposal(ctx, edited.proposalId) : null;
  if (proposal) {
    if (proposal.kind !== 'production') throw badRequest(`${proposal.proposalCode} is not a production plan`);
    // A partly applied plan has records stamped by op seq; re-numbered ops would make the resumed apply
    // reuse the wrong records, so only a clean draft can be edited.
    if (!['draft', 'failed'].includes(proposal.status))
      throw conflict(`${proposal.proposalCode} is ${proposal.status}; make a new plan to change it`, {
        status: proposal.status,
      });
    if (proposal.status === 'failed' || proposal.appliedOps)
      throw conflict(`${proposal.proposalCode} was partly applied; resume it or make a new plan`, {
        status: proposal.status,
      });
  }
  const dueDate = new Date(edited.dueDate);
  if (Number.isNaN(dueDate.getTime())) throw badRequest('The due date is not a valid date');
  assertPlanDates(now, [dueDate, ...edited.jobCards.flatMap((c) => [c.start, c.end])]);
  const plantId =
    edited.plantId ?? (proposal?.plantId ? String(proposal.plantId) : null) ?? ctx.plantLock ?? null;
  const assetIds = [
    ...new Set([
      ...edited.jobCards.map((c) => String(c.assetId)),
      ...(await capableMachines(ctx, edited.partName)),
    ]),
  ];
  const last = Math.max(...edited.jobCards.map((c) => ms(c.end)), ms(dueDate));
  const end = new Date(last + 14 * DAY);
  const calendar = await buildCalendar(ctx, { plantId, assetIds, start: now, end, now });
  const applied = proposal
    ? await getModule('jobcards')
        .Model.find({ proposalId: String(proposal._id) })
        .select('_id')
        .lean()
    : [];
  const excludeIds = new Set(applied.map((j) => String(j._id)));
  const people = await loadPeople(ctx, {
    department: 'Production',
    plantId,
    window: { start: now, end },
    excludeBookings: [...excludeIds].map((id) => ({ module: 'jobcards', id })),
  });
  const plant = plantOf(ctx, plantId ?? calendar.machines[0]?.plantId);
  // No typed rate: the planner's (stored on the proposal), else the part's history, else 2 %.
  const plannedRate =
    edited.rejectionPct != null
      ? undefined
      : (proposal?.input?.rejectionRate ??
        (await historicalRejection(ctx, edited.partName, now)) ??
        undefined);
  const { bars, rejectionRate, ...result } = checkPlan(calendar, edited, {
    plant,
    zone: zoneOf(ctx),
    people,
    excludeIds,
    rejectionRate: plannedRate,
  });

  const quantity = Math.round(edited.quantity);
  const title = planTitle(calendar, edited.partName, quantity, dueDate);
  const horizon = { start: new Date(Math.floor(ms(now) / HOUR) * HOUR), end: new Date(last + 12 * HOUR) };
  const plan = toPlanBlock(
    ctx,
    {
      ...(proposal ?? {}),
      title,
      horizon,
      diff: { bars, delays: [] },
      feasibility: result.feasibility,
      risks: result.risks,
    },
    calendar,
  );
  if (!proposal) delete plan.proposal;

  const machinesById = new Map(calendar.machines.map((m) => [m.assetId, m]));
  const toolsById = new Map(calendar.tools.map((t) => [t.toolId, t]));
  let fresh = proposal;
  if (proposal) {
    const customerName = proposal.ops?.[1]?.data?.jobName?.split(' – ').slice(1).join(' – ') || undefined;
    const planRef = proposal.ops?.[0]?.op === 'update' ? proposal.ops[0].id : '$op:0';
    const ops = [
      proposal.ops?.[0]?.op === 'update'
        ? proposal.ops[0]
        : planOp({
            title,
            partName: edited.partName,
            quantity,
            dueDate,
            plantId,
            customerId: edited.customerId,
          }),
      ...result.jobCards.map((c, i) => {
        const m = machinesById.get(c.assetId);
        const t = toolsById.get(c.toolId);
        const part = t?.parts.find((p) => same(p.partName, edited.partName));
        return jobCardOp({
          seq: i + 1,
          machine: m ?? { assetId: c.assetId, name: c.key },
          tool: t ?? { toolId: c.toolId, name: 'mould', cycleSec: 30 },
          part: part ?? { id: undefined, partName: edited.partName, perShot: 1 },
          partName: edited.partName,
          q: c.target,
          r: rejectionRate,
          start: c.start,
          end: c.end,
          planRef,
          customerName,
          operators: c.operators,
        });
      }),
    ];
    const jobCards = result.jobCards.map(({ issues: _i, ...c }) => c);
    await getModule('planproposals').Model.updateOne(
      { _id: proposal._id, companyId: ctx.companyId },
      {
        $set: {
          title,
          ops,
          diff: { bars, delays: [], jobCards, rejectionRate },
          feasibility: result.feasibility,
          risks: result.risks,
          issues: result.issues,
          adjustments: result.adjustments,
          'input.edited': edited,
          assetIds: [...new Set(jobCards.map((c) => c.assetId))],
        },
      },
    );
  }

  let explanation = null;
  let aiError;
  try {
    explanation = await feasibilityText(ctx, {
      title,
      partName: edited.partName,
      quantity,
      dueDate,
      feasibility: result.feasibility,
      jobCards: result.jobCards,
      issues: result.issues,
      adjustments: result.adjustments,
      risks: result.risks,
    });
    if (proposal)
      await getModule('planproposals').Model.updateOne({ _id: proposal._id }, { $set: { explanation } });
  } catch (err) {
    // The check stands without its explanation; the UI shows the deterministic verdict line.
    const ai = err instanceof AiUnavailableError;
    if (!ai) logger.warn({ err }, 'plan check explanation failed');
    aiError = ai
      ? { code: err.code, message: err.message }
      : { code: 'AI_ERROR', message: 'The AI explanation is unavailable right now' };
  }
  if (proposal) fresh = await getModule('planproposals').Model.findById(proposal._id).lean();
  return {
    ...result,
    plan,
    explanation,
    ...(aiError ? { aiError } : {}),
    ...(fresh ? { proposal: fresh } : {}),
  };
};
