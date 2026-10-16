import { badRequest } from '../../lib/errors.js';

const INBOUND = new Set(['add', 'deposit']);

/** Spare part transactions move stock in or out of one lot. */
export const transactionHooks = {
  beforeCreate: async ({ ctx, doc, svc }) => {
    if (!doc.inventoryId) throw badRequest('Choose the stock lot (inventoryId) this transaction applies to');
    const lot = await svc
      .getModule('sparepartinventories')
      .Model.findOne({ _id: doc.inventoryId, companyId: ctx.companyId, deleted: { $ne: true } })
      .lean();
    if (!lot) throw badRequest('Stock lot not found');
    if (String(lot.sparePartId) !== String(doc.sparePartId))
      throw badRequest('That stock lot belongs to another part');
    if (!INBOUND.has(doc.type) && lot.stockQuantity < doc.quantity) {
      throw badRequest(`Only ${lot.stockQuantity} left in that lot`);
    }
    doc.unitCost = lot.cost ?? 0;
    doc.actionPerformedBy = ctx.userId;
  },
  afterCreate: async ({ doc, svc }) => {
    const delta = INBOUND.has(doc.type) ? doc.quantity : -doc.quantity;
    // ponytail: no transaction; the guard stops stock going negative under a race, the extra row stays.
    await svc
      .getModule('sparepartinventories')
      .Model.updateOne(
        { _id: doc.inventoryId, ...(delta < 0 ? { stockQuantity: { $gte: -delta } } : {}) },
        { $inc: { stockQuantity: delta } },
      );
  },
};
