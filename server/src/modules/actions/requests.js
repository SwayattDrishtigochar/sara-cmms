const DAY_MS = 86_400_000;

/** A new maintenance request also opens a work order (CMMS requestController behaviour). */
export const requestHooks = {
  beforeCreate: ({ ctx, doc, opts }) => {
    doc.status = 'Open';
    doc.comments = [
      {
        user: ctx.userId,
        type: 'automate',
        comment: opts.source === 'agent' ? 'Opened the request via SARA.' : 'Opened the request.',
        createdAt: new Date(),
      },
    ];
  },
  afterCreate: async ({ ctx, doc, svc }) => {
    const workOrder = await svc.create(
      { ...ctx, role: 'system' },
      'workorders',
      {
        name: doc.name,
        description: doc.description ?? undefined,
        asset: doc.asset ? String(doc.asset) : undefined,
        toolAllocation: doc.toolAllocation ? String(doc.toolAllocation) : undefined,
        plantId: doc.plantId ? String(doc.plantId) : undefined,
        location: doc.location ?? undefined,
        priority: 'High',
        category: doc.type || 'Breakdown',
        dueDate: new Date(Date.now() + 7 * DAY_MS),
        requestId: String(doc._id),
      },
      { source: 'system' },
    );
    await svc.getModule('requests').Model.updateOne({ _id: doc._id }, { $set: { workOrder: workOrder._id } });
    doc.workOrder = workOrder._id;
  },
};
