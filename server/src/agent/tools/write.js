import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { TRANSITIONS, WORK_STATUSES } from '../../modules/actions/workOrders.js';
import { assertCan } from '../../modules/permissions.js';
import { records } from '../../modules/records.js';
import { labelOf } from '../../modules/registry.js';
import { redact } from '../validators/redact.js';
import { findByIdOrCode, labelsFor, linkTo, readableModule } from './common.js';
import { completeRecord, decidedText, isAutoWord, normTasks, pickTechnician } from './defaults.js';

/**
 * Write tools (phase 4 §2). `preview` runs `records.*` with `dryRun` (validation, refs, permissions,
 * labels, diff) and returns the confirm block; `run` happens only after the user confirms. Both go
 * through `completeRecord` first, so what the user did not say (priority, due date, technician, checklist,
 * names instead of ids) is decided the same way in the preview and in the run.
 */

const item = () => z.record(z.string(), z.any());
const canWrite = (ctx) => ctx.role !== 'view';
const MAX_BULK = 50;

const writableModule = (ctx, name, action) => {
  const mod = readableModule(ctx, name);
  if (!mod.agentWritable)
    throw forbidden(`${mod.label} can't be changed from chat; use the ${mod.label} page`);
  assertCan(ctx, mod, action);
  return mod;
};

const confirmBlock = (payload) => ({ type: 'confirm', payload });
/** The fields a create preview shows: what was asked for, plus the status the record starts in. */
export const shownFields = (doc, data) =>
  Object.fromEntries(Object.entries(doc).filter(([k]) => k in data || /status$/i.test(k)));
const plural = (mod, n) => (n === 1 ? mod.singular.toLowerCase() : mod.label.toLowerCase());
const described = (mod, doc) => ({
  id: String(doc._id),
  label: labelOf(mod, doc),
  link: linkTo(mod.name, doc._id),
});

/** Zod issues → one plain line per field with the allowed values, so the model fixes the call instead of giving up. */
export const fieldErrors = (mod, err) => {
  if (!Array.isArray(err.details) || !err.details.length) return err.message;
  const writable = Object.entries(mod.fields)
    .filter(([, s]) => !s.readOnly && !s.hidden)
    .map(([k]) => k);
  const lines = err.details.map(({ path, message }) => {
    const spec = mod.fields[String(path).split('.')[0]];
    if (path === '(root)') return `${message}. Fields of ${mod.label}: ${writable.join(', ')}`;
    if (spec?.type === 'enum') return `${path}: ${message} (one of ${spec.values.join(', ')})`;
    if (spec?.type === 'ref' || spec?.type === 'refs')
      return `${path}: ${message} (a name, code or id works)`;
    if (spec?.type === 'date') return `${path}: ${message} (ISO 8601 or words like "tomorrow")`;
    return `${path}: ${message}`;
  });
  return lines.join('; ');
};

const prepared = async (mod, i, fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err?.status >= 500 || !err?.status) throw err;
    throw badRequest(`Item ${i + 1}: ${fieldErrors(mod, err)}`, err.details);
  }
};

/** Lists ops the model may send on an update: addPeople/removePeople/addTasks (merged with the record). */
const LIST_OPS = ['addPeople', 'removePeople', 'addTasks'];
const takeListOps = (data) => {
  const ops = {};
  for (const key of LIST_OPS) {
    if (data[key] == null) continue;
    ops[key] = [].concat(data[key]);
    delete data[key];
  }
  if (data.people && !Array.isArray(data.people) && typeof data.people === 'object') {
    if (data.people.add) ops.addPeople = [].concat(data.people.add);
    if (data.people.remove) ops.removePeople = [].concat(data.people.remove);
    delete data.people;
  }
  return Object.keys(ops).length ? ops : null;
};

/** The best free technician for a stored work order (its plant, asset type and category), or null. */
const autoTechnician = async (ctx, wo, exclude) => {
  const asset = wo.asset
    ? await records.getModule('assets').Model.findOne({ _id: wo.asset, companyId: ctx.companyId }).lean()
    : null;
  return pickTechnician(ctx, {
    plantId: wo.plantId ?? asset?.plantId ?? undefined,
    assetType: asset?.typeOfAsset,
    category: wo.category,
    durationMin: wo.estimatedDurationMin ?? 60,
    exclude,
  });
};

/** An update's data, completed: aliases, names → ids, and add/remove lists merged with the current record. */
const preparedUpdate = async (ctx, module, id, data) => {
  const raw = { ...data };
  let ops = takeListOps(raw);
  const { item, decided } = await completeRecord(ctx, module, raw, { fill: false });
  if (item.$autoPeople) {
    // people: "auto" on an update = replace with whoever SARA picks.
    delete item.$autoPeople;
    ops ??= {};
    ops.addPeople = ['auto'];
    delete item.people;
  }
  if (ops) {
    const before = await records.get(ctx, module, id, { populate: false });
    if (ops.addPeople || ops.removePeople) {
      const resolve = async (list) =>
        (await completeRecord(ctx, module, { people: list }, { fill: false })).item.people ?? [];
      const current = raw.people === undefined ? (before.people ?? []).map(String) : [];
      const add = await resolve((ops.addPeople ?? []).filter((p) => !isAutoWord(p)));
      if ((ops.addPeople ?? []).some(isAutoWord)) {
        const tech = await autoTechnician(ctx, before, [...current, ...add]);
        if (tech) {
          add.push(tech.id);
          decided.push({ field: 'people', value: tech.name, why: tech.why });
        }
      }
      const remove = new Set(await resolve(ops.removePeople ?? []));
      item.people = [...new Set([...current.filter((p) => !remove.has(p)), ...add])];
    }
    if (ops.addTasks) {
      const rows = normTasks(ops.addTasks, 'Added via SARA');
      // Stored rows carry ObjectIds and Dates; the schema wants their string forms.
      item.taskAndChecklist = [...JSON.parse(JSON.stringify(before.taskAndChecklist ?? [])), ...rows];
    }
  }
  return { item, decided };
};

export const workOrderFor = async (ctx, ref) => {
  const wo = await findByIdOrCode(ctx, 'workorders', ref);
  const labels = await labelsFor(ctx, 'assets', [wo.asset]);
  return {
    doc: wo,
    info: {
      id: String(wo._id),
      code: wo.workOrderId,
      name: wo.name,
      status: wo.workStatus,
      priority: wo.priority,
      asset: labels.get(String(wo.asset)) ?? null,
      link: linkTo('workorders', wo._id),
    },
  };
};

/** The records a filtered bulk delete reaches (names → ids in the filter), capped at MAX_BULK. */
const bulkTargets = async (ctx, mod, filter) => {
  const raw = { ...filter };
  if (mod.name === 'workorders' && raw.status != null && raw.workStatus == null) {
    raw.workStatus = raw.status;
    delete raw.status;
  }
  const { item: where } = await completeRecord(ctx, mod.name, raw, { fill: false, filter: true });
  if (!Object.keys(where).length)
    throw badRequest('Say which records: a filter such as { workStatus: "Open" } for all open ones');
  const { items, total } = await records.list(ctx, mod.name, {
    filter: where,
    limit: MAX_BULK,
    populate: false,
  });
  if (total > MAX_BULK)
    throw badRequest(
      `That matches ${total} ${mod.label.toLowerCase()}; narrow the filter to at most ${MAX_BULK}`,
    );
  if (!total) throw badRequest(`No ${mod.label.toLowerCase()} match that filter; nothing to delete`);
  return { where, items };
};

export const writeTools = [
  {
    name: 'create_record',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Creates 1–20 records of a module (e.g. work orders, PMs, requests, spare parts). Pass what the user said; names and codes are fine for refs (asset: "Furnace 2", people: ["Ramesh"]), words for dates (dueDate: "tomorrow"). Whatever is missing on a work order, PM or request SARA decides herself (title, description, category, priority, due date, duration, checklist, a free technician) and shows it on the confirm card, so never ask the user for those. Put the facts of the conversation (symptoms, live readings, root cause) in `context`; they become the description. Example: { module: "workorders", context: "Oil temp 68 °C, pressure low since shift A", items: [{ name: "Coolant leak", asset: "IMM 2", priority: "High", tasks: ["Check hose", "Replace seal"] }] }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      items: z.array(item()).min(1).max(20),
      context: z.string().max(4000).optional(),
    }),
    preview: async (ctx, { module, items, context }) => {
      const mod = writableModule(ctx, module, 'create');
      const previews = [];
      for (const [i, raw] of items.entries()) {
        await prepared(mod, i, async () => {
          const { item: data, decided } = await completeRecord(ctx, module, raw, { hints: context });
          const { doc, labels } = await records.create(ctx, module, data, { source: 'agent', dryRun: true });
          const shown = redact(shownFields(doc, data));
          const text = decidedText(ctx, decided, labels);
          if (text) shown.saraDecided = text;
          previews.push({ doc: shown, labels, decided });
        });
      }
      return confirmBlock({
        tool: 'create_record',
        action: 'create',
        module,
        moduleLabel: mod.label,
        label: `Create ${items.length} ${plural(mod, items.length)}`,
        items: previews,
      });
    },
    run: async (ctx, { module, items, context }) => {
      const mod = writableModule(ctx, module, 'create');
      const created = [];
      for (const [i, raw] of items.entries()) {
        try {
          const { item: data, decided } = await completeRecord(ctx, module, raw, { hints: context });
          const doc = await records.create(ctx, module, data, { source: 'agent' });
          created.push({ ...described(mod, doc), decided: decidedText(ctx, decided) || undefined });
        } catch (err) {
          return {
            forModel: {
              created,
              failed: { index: i + 1, error: fieldErrors(mod, err), details: err.details },
            },
            summary: `Created ${created.length} of ${items.length} ${plural(mod, items.length)}`,
            rowCount: created.length,
            ok: false,
          };
        }
      }
      return {
        forModel: { created },
        summary: `Created ${created.length} ${plural(mod, created.length)}`,
        rowCount: created.length,
        data: { rows: created },
      };
    },
  },
  {
    name: 'update_record',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Updates fields of 1–20 records of a module by id (partial data; null clears a field). Names, codes and words work as in create_record. On work orders use addPeople / removePeople (names or ids) to change assignees without touching the others, and addTasks (strings) to extend the checklist; people: [...] replaces the whole list. The user sees a before/after diff and must confirm. Example: { module: "workorders", updates: [{ id: "<id>", data: { addPeople: ["Ramesh Kumar"], priority: "high", dueDate: "next Friday" } }] }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      updates: z
        .array(z.object({ id: z.string().min(1), data: item() }))
        .min(1)
        .max(20),
    }),
    preview: async (ctx, { module, updates }) => {
      const mod = writableModule(ctx, module, 'update');
      const items = [];
      for (const [i, { id, data }] of updates.entries()) {
        await prepared(mod, i, async () => {
          const { item: patch, decided } = await preparedUpdate(ctx, module, id, data);
          const { before, changes, labels } = await records.update(ctx, module, id, patch, {
            source: 'agent',
            dryRun: true,
          });
          const text = decidedText(ctx, decided, labels);
          items.push({
            id,
            label: labelOf(mod, before),
            changes: redact(changes),
            labels,
            ...(text ? { decided, note: `SARA decided: ${text}` } : {}),
          });
        });
      }
      return confirmBlock({
        tool: 'update_record',
        action: 'update',
        module,
        moduleLabel: mod.label,
        label: `Update ${items.length} ${plural(mod, items.length)}`,
        items,
      });
    },
    run: async (ctx, { module, updates }) => {
      const mod = writableModule(ctx, module, 'update');
      const updated = [];
      for (const [i, { id, data }] of updates.entries()) {
        try {
          const { item: patch } = await preparedUpdate(ctx, module, id, data);
          const { after, changes } = await records.update(ctx, module, id, patch, { source: 'agent' });
          updated.push({ ...described(mod, after), changes: redact(changes) });
        } catch (err) {
          return {
            forModel: {
              updated,
              failed: { index: i + 1, id, error: fieldErrors(mod, err), details: err.details },
            },
            summary: `Updated ${updated.length} of ${updates.length}`,
            rowCount: updated.length,
            ok: false,
          };
        }
      }
      return {
        forModel: { updated },
        summary: `Updated ${updated.length} ${plural(mod, updated.length)}`,
        rowCount: updated.length,
        data: { rows: updated },
      };
    },
  },
  {
    name: 'delete_record',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Deletes (soft) records of a module with a reason: by ids (1–20), or every record matching a filter (at most 50, e.g. all open work orders of one asset: { module: "workorders", filter: { workStatus: "Open", asset: "IMM 2" } }). "Delete all work orders" without a scope is refused once: offer the user "all open ones" (filter { workStatus: "Open" }) or a narrower set. The user sees the names and must confirm. Example: { module: "consumables", ids: ["<id>"], reason: "Duplicate entry" }.',
    schema: z
      .object({
        module: z.string().min(1).max(60),
        ids: z.array(z.string().min(1)).min(1).max(20).optional(),
        filter: z.record(z.string(), z.any()).optional(),
        reason: z.string().min(1).max(500),
      })
      .refine((v) => v.ids?.length || (v.filter && Object.keys(v.filter).length), {
        message:
          'Say which records: ids, or a filter such as { workStatus: "Open" } for all open ones. Deleting a whole module at once is not offered; propose the open ones instead.',
      }),
    preview: async (ctx, { module, ids, filter, reason }) => {
      const mod = writableModule(ctx, module, 'delete');
      const items = [];
      if (ids) {
        for (const id of ids) {
          const { label } = await records.remove(ctx, module, id, { source: 'agent', dryRun: true, reason });
          items.push({ id, label });
        }
      } else {
        const { where, items: docs } = await bulkTargets(ctx, mod, filter);
        for (const doc of docs) items.push({ id: String(doc._id), label: labelOf(mod, doc) });
        filter = where;
      }
      return confirmBlock({
        tool: 'delete_record',
        action: 'delete',
        module,
        moduleLabel: mod.label,
        label: `Delete ${items.length} ${plural(mod, items.length)}`,
        items,
        count: items.length,
        ...(ids ? {} : { filter }),
        reason,
      });
    },
    run: async (ctx, { module, ids, filter, reason }) => {
      const mod = writableModule(ctx, module, 'delete');
      const targets = ids ?? (await bulkTargets(ctx, mod, filter)).items.map((d) => String(d._id));
      const deleted = [];
      for (const id of targets) {
        try {
          const { label } = await records.remove(ctx, module, id, { source: 'agent', reason });
          deleted.push({ id, label });
        } catch (err) {
          return {
            forModel: { deleted, failed: { id, error: err.message } },
            summary: `Deleted ${deleted.length} of ${targets.length}`,
            rowCount: deleted.length,
            ok: false,
          };
        }
      }
      return {
        forModel: { deleted },
        summary: `Deleted ${deleted.length} ${plural(mod, deleted.length)}`,
        rowCount: deleted.length,
        data: { rows: deleted },
      };
    },
  },
  {
    name: 'update_work_order_status',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Moves a work order (by code like WO-42 or id) to a new status with an optional note. Allowed moves: Open→In Progress→On Hold/Completed→Closed; Completed/Closed→Re Open. The user must confirm. Example: { workOrder: "WO-42", workStatus: "Completed", note: "Replaced bearing" }.',
    schema: z.object({
      workOrder: z.string().min(1).max(60),
      workStatus: z.enum(WORK_STATUSES),
      note: z.string().max(4000).optional(),
    }),
    preview: async (ctx, { workOrder, workStatus, note }) => {
      const { doc, info } = await workOrderFor(ctx, workOrder);
      const allowed = TRANSITIONS[doc.workStatus] ?? [];
      if (doc.workStatus === workStatus) throw badRequest(`${info.code} is already ${workStatus}`);
      if (!allowed.includes(workStatus)) {
        throw badRequest(
          `Can't move ${info.code} from ${doc.workStatus} to ${workStatus}. Allowed next: ${allowed.join(', ') || 'none'}`,
        );
      }
      const openTasks =
        workStatus === 'Completed'
          ? (doc.taskAndChecklist ?? []).flatMap((t) => t.tasks ?? []).filter((t) => !t.completed)
          : [];
      if (openTasks.length) {
        throw badRequest(
          `Finish the checklist of ${info.code} first: ${openTasks.length} task(s) open (${openTasks
            .slice(0, 3)
            .map((t) => t.task)
            .join('; ')})`,
        );
      }
      await records.runAction(
        ctx,
        'workorders',
        doc._id,
        'status',
        { workStatus, note },
        { source: 'agent', dryRun: true },
      );
      return confirmBlock({
        tool: 'update_work_order_status',
        action: 'status',
        module: 'workorders',
        moduleLabel: 'Work Orders',
        label: `Mark ${info.code} as ${workStatus}`,
        workOrder: info,
        from: doc.workStatus,
        to: workStatus,
        note: note ?? null,
      });
    },
    run: async (ctx, { workOrder, workStatus, note }) => {
      const { doc } = await workOrderFor(ctx, workOrder);
      const after = await records.runAction(
        ctx,
        'workorders',
        doc._id,
        'status',
        { workStatus, note },
        { source: 'agent' },
      );
      const result = {
        id: String(after._id),
        code: after.workOrderId,
        name: after.name,
        workStatus: after.workStatus,
        link: linkTo('workorders', after._id),
      };
      return {
        forModel: result,
        summary: `${after.workOrderId} → ${after.workStatus}`,
        rowCount: 1,
        data: { rows: [result] },
      };
    },
  },
  {
    name: 'add_work_order_comment',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Adds a comment to a work order (by code or id). The user must confirm. Example: { workOrder: "WO-42", comment: "Waiting for the seal kit" }.',
    schema: z.object({ workOrder: z.string().min(1).max(60), comment: z.string().min(1).max(4000) }),
    preview: async (ctx, { workOrder, comment }) => {
      const { doc, info } = await workOrderFor(ctx, workOrder);
      if (doc.workStatus === 'Closed') throw badRequest(`Can't comment on ${info.code}: it is closed`);
      await records.runAction(
        ctx,
        'workorders',
        doc._id,
        'comment',
        { comment },
        { source: 'agent', dryRun: true },
      );
      return confirmBlock({
        tool: 'add_work_order_comment',
        action: 'comment',
        module: 'workorders',
        moduleLabel: 'Work Orders',
        label: `Comment on ${info.code}`,
        workOrder: info,
        comment,
      });
    },
    run: async (ctx, { workOrder, comment }) => {
      const { doc } = await workOrderFor(ctx, workOrder);
      const after = await records.runAction(
        ctx,
        'workorders',
        doc._id,
        'comment',
        { comment },
        { source: 'agent' },
      );
      const result = {
        id: String(after._id),
        code: after.workOrderId,
        comments: after.comments?.length ?? null,
        link: linkTo('workorders', after._id),
      };
      return {
        forModel: result,
        summary: `Comment added to ${after.workOrderId}`,
        rowCount: 1,
        data: { rows: [result] },
      };
    },
  },
];
