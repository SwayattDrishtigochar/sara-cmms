import { DateTime } from 'luxon';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { records } from '../../modules/records.js';
import { freeFor, loadPeople, skillsForTask } from '../../planning/people.js';
import { redact } from '../validators/redact.js';
import { fmtDate, rowsResult } from './common.js';
import { completeRecord, findRef, pickTechnician } from './defaults.js';
import { lenientTimeRange } from './resolve.js';
import { workOrderFor } from './write.js';

/**
 * People tools: `available_people` (read) lists who is free so the model can choose or let SARA choose;
 * `assign_work_order` (confirmed) puts people on a work order, `people: "auto"` = SARA picks the best
 * free technician for its category and asset.
 */

const HOUR = 3_600_000;
const canWrite = (ctx) => ctx.role !== 'view';
const clock = (ctx, d) => (d ? fmtDate(ctx, d, { time: true }).slice(-5) : null);

const windowOf = (ctx, text) => {
  if (!text || /^(now|abhi|right now|today)$/i.test(text.trim())) {
    const start = new Date();
    return { start, end: new Date(start.getTime() + 8 * HOUR), label: 'next 8 hours' };
  }
  const r = lenientTimeRange({ text }, ctx, DateTime.now());
  return { start: new Date(r.start), end: new Date(r.stop), label: r.label };
};

export const peopleTools = [
  {
    name: 'available_people',
    group: 'write',
    permission: canWrite,
    description:
      'Who is free: people of a department (default Maintenance) with their skills, how long they are free and their load in a window (default the next 8 hours). Use it to pick a technician yourself or let SARA pick (assign_work_order with people: "auto"); never ask the user "which technician?" when they said anyone/whoever is free. Example: { department: "Maintenance", skills: ["hydraulics"], window: "today shift B", asset: "IMM 2" }.',
    schema: z.object({
      department: z.enum(['Maintenance', 'Production']).default('Maintenance'),
      skills: z.array(z.string().min(1).max(40)).max(10).optional(),
      window: z.string().max(120).optional().describe('e.g. "now", "tomorrow", "today shift B"'),
      asset: z
        .string()
        .max(120)
        .optional()
        .describe('Asset name, code or id: its plant and type pick the skills'),
      category: z.string().max(40).optional().describe('Work order category, adds its skills'),
    }),
    run: async (ctx, { department, skills, window: text, asset: assetRef, category }) => {
      const asset = assetRef ? (await findRef(ctx, 'assets', assetRef)).doc : null;
      const window = windowOf(ctx, text);
      const wanted = [
        ...(skills ?? []).map((s) => s.toLowerCase()),
        ...skillsForTask({ category, assetType: asset?.typeOfAsset }),
      ];
      const people = await loadPeople(ctx, {
        department,
        plantId: asset?.plantId ?? ctx.plantId ?? undefined,
        window: { start: window.start, end: window.end },
      });
      const now = window.start;
      const rows = people
        .map((p) => {
          const probe = { start: now, end: new Date(now.getTime() + HOUR) };
          const free = freeFor(p, probe);
          const shiftEnd = p.onShift.find((w) => w.start <= now && now < w.end)?.end ?? null;
          const next = p.bookings.find((b) => b.start > now)?.start ?? null;
          const freeUntil = free ? (next && (!shiftEnd || next < shiftEnd) ? next : shiftEnd) : null;
          return {
            id: p.userId,
            name: p.name,
            title: p.title,
            department: p.department,
            skills: p.skills,
            skillMatch: p.skills.some((s) => wanted.includes(s)),
            free,
            freeUntil: clock(ctx, freeUntil),
            onShift: p.shiftName,
            load: p.loadHours,
            busy: p.bookings.slice(0, 3).map((b) => `${b.code} ${clock(ctx, b.start)}–${clock(ctx, b.end)}`),
          };
        })
        .sort(
          (a, b) =>
            Number(b.free) - Number(a.free) ||
            Number(b.skillMatch) - Number(a.skillMatch) ||
            a.load - b.load ||
            a.name.localeCompare(b.name),
        );
      return rowsResult({
        rows,
        what: `people (${window.label})`,
        extra: {
          window: window.label,
          skillsWanted: wanted,
          hint: 'Free people come first; a skillMatch is a bonus, not a must. Simplest: people: "auto" in create_record or assign_work_order lets SARA pick (first free skill match, else least loaded)',
        },
      });
    },
  },
  {
    name: 'assign_work_order',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Assigns people to a work order (code like WO-42 or id). people: "auto" lets SARA pick the best free maintenance technician for its category and asset; or give names/ids. mode add (default) keeps the current assignees, replace swaps them. The user sees the change and must confirm. Example: { workOrder: "WO-42", people: "auto" }.',
    schema: z.object({
      workOrder: z.string().min(1).max(60),
      people: z
        .union([z.literal('auto'), z.array(z.string().min(1).max(120)).min(1).max(10)])
        .default('auto'),
      mode: z.enum(['add', 'replace']).default('add'),
    }),
    preview: async (ctx, args) => {
      const { doc, info, people, why, labels, changes } = await plan(ctx, args);
      return {
        type: 'confirm',
        payload: {
          tool: 'assign_work_order',
          action: 'update',
          module: 'workorders',
          moduleLabel: 'Work Orders',
          label: `Assign ${info.code} to ${people.map((id) => labels[id] ?? id).join(', ')}`,
          workOrder: info,
          items: [
            {
              id: String(doc._id),
              label: `${info.code} · ${info.name}`,
              changes: redact(changes),
              labels,
              note: why,
            },
          ],
          decided: why,
        },
      };
    },
    run: async (ctx, args) => {
      const { doc, people, why } = await plan(ctx, args);
      const { after } = await records.update(ctx, 'workorders', doc._id, { people }, { source: 'agent' });
      const labels = await records.refLabels(ctx, records.getModule('workorders'), after);
      const result = {
        id: String(after._id),
        code: after.workOrderId,
        people: (after.people ?? []).map((id) => labels[String(id)] ?? String(id)),
        decided: why,
      };
      return {
        forModel: result,
        summary: `${after.workOrderId} assigned to ${result.people.join(', ')}`,
        rowCount: 1,
        data: { rows: [result] },
      };
    },
  },
];

/** Who ends up on the work order and why; the dry-run diff and labels for the card. */
const plan = async (ctx, { workOrder, people: wanted, mode }) => {
  const { doc, info } = await workOrderFor(ctx, workOrder);
  if (['Completed', 'Closed'].includes(doc.workStatus))
    throw badRequest(`${info.code} is ${doc.workStatus}; re-open it before assigning people`);
  const current = (doc.people ?? []).map(String);
  let chosen;
  let why;
  if (wanted === 'auto') {
    const asset = doc.asset
      ? await records.getModule('assets').Model.findOne({ _id: doc.asset, companyId: ctx.companyId }).lean()
      : null;
    const tech = await pickTechnician(ctx, {
      plantId: doc.plantId ?? asset?.plantId ?? undefined,
      assetType: asset?.typeOfAsset,
      category: doc.category,
      durationMin: doc.estimatedDurationMin ?? 60,
      exclude: mode === 'add' ? current : [],
    });
    if (!tech) throw badRequest('No maintenance technician found for this plant; give a name instead');
    chosen = [tech.id];
    why = `SARA decided: ${tech.name} (${tech.why})`;
  } else {
    const { item, decided } = await completeRecord(ctx, 'workorders', { people: wanted }, { fill: false });
    chosen = item.people;
    why = decided.length ? `SARA decided: ${decided.map((d) => `${d.value} (${d.why})`).join('; ')}` : null;
  }
  const people = mode === 'replace' ? chosen : [...new Set([...current, ...chosen])];
  if (people.length === current.length && people.every((id) => current.includes(id)))
    throw badRequest(`${info.code} is already assigned to those people`);
  const { changes, labels } = await records.update(
    ctx,
    'workorders',
    doc._id,
    { people },
    { source: 'agent', dryRun: true },
  );
  return { doc, info, people, why, labels, changes };
};
