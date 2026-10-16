import { z } from 'zod';
import { badRequest, forbidden } from '../../lib/errors.js';
import { TRANSITIONS, WORK_STATUSES } from '../../modules/actions/workOrders.js';
import { assertCan } from '../../modules/permissions.js';
import { records } from '../../modules/records.js';
import { labelOf } from '../../modules/registry.js';
import { redact } from '../validators/redact.js';
import { findByIdOrCode, labelsFor, linkTo, readableModule } from './common.js';

/**
 * Write tools (phase 4 §2). `preview` runs `records.*` with `dryRun` (validation, refs, permissions,
 * labels, diff) and returns the confirm block; `run` happens only after the user confirms.
 */

const item = () => z.record(z.string(), z.any());
const canWrite = (ctx) => ctx.role !== 'view';

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

const workOrderFor = async (ctx, ref) => {
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

export const writeTools = [
  {
    name: 'create_record',
    group: 'write',
    requiresConfirmation: true,
    permission: canWrite,
    description:
      'Creates 1–20 records of a module (e.g. work orders, requests, spare parts). Resolve names to ids first (asset, people, tool). The user sees a preview and must confirm. Example: { module: "workorders", items: [{ name: "Coolant leak", asset: "<id>", priority: "High", dueDate: "2026-10-17T00:00:00Z", people: ["<id>"] }] }.',
    schema: z.object({ module: z.string().min(1).max(60), items: z.array(item()).min(1).max(20) }),
    preview: async (ctx, { module, items }) => {
      const mod = writableModule(ctx, module, 'create');
      const previews = [];
      for (const [i, data] of items.entries()) {
        try {
          const { doc, labels } = await records.create(ctx, module, data, { source: 'agent', dryRun: true });
          previews.push({ doc: redact(shownFields(doc, data)), labels });
        } catch (err) {
          throw badRequest(`Item ${i + 1}: ${err.message}`, err.details);
        }
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
    run: async (ctx, { module, items }) => {
      const mod = writableModule(ctx, module, 'create');
      const created = [];
      for (const [i, data] of items.entries()) {
        try {
          created.push(described(mod, await records.create(ctx, module, data, { source: 'agent' })));
        } catch (err) {
          return {
            forModel: { created, failed: { index: i + 1, error: err.message, details: err.details } },
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
      'Updates fields of 1–20 records of a module by id (partial data; null clears a field). The user sees a before/after diff and must confirm. Example: { module: "spareparts", updates: [{ id: "<id>", data: { minimumQuantity: 10 } }] }.',
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
        try {
          const { before, changes, labels } = await records.update(ctx, module, id, data, {
            source: 'agent',
            dryRun: true,
          });
          items.push({ id, label: labelOf(mod, before), changes: redact(changes), labels });
        } catch (err) {
          throw badRequest(`Update ${i + 1} (${id}): ${err.message}`, err.details);
        }
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
          const { after, changes } = await records.update(ctx, module, id, data, { source: 'agent' });
          updated.push({ ...described(mod, after), changes: redact(changes) });
        } catch (err) {
          return {
            forModel: { updated, failed: { index: i + 1, id, error: err.message, details: err.details } },
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
      'Deletes (soft) 1–20 records of a module by id, with a reason. The user sees the record names and must confirm. Example: { module: "consumables", ids: ["<id>"], reason: "Duplicate entry" }.',
    schema: z.object({
      module: z.string().min(1).max(60),
      ids: z.array(z.string().min(1)).min(1).max(20),
      reason: z.string().min(1).max(500),
    }),
    preview: async (ctx, { module, ids, reason }) => {
      const mod = writableModule(ctx, module, 'delete');
      const items = [];
      for (const id of ids) {
        const { label } = await records.remove(ctx, module, id, { source: 'agent', dryRun: true, reason });
        items.push({ id, label });
      }
      return confirmBlock({
        tool: 'delete_record',
        action: 'delete',
        module,
        moduleLabel: mod.label,
        label: `Delete ${items.length} ${plural(mod, items.length)}`,
        items,
        reason,
      });
    },
    run: async (ctx, { module, ids, reason }) => {
      const mod = writableModule(ctx, module, 'delete');
      const deleted = [];
      for (const id of ids) {
        try {
          const { label } = await records.remove(ctx, module, id, { source: 'agent', reason });
          deleted.push({ id, label });
        } catch (err) {
          return {
            forModel: { deleted, failed: { id, error: err.message } },
            summary: `Deleted ${deleted.length} of ${ids.length}`,
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
