/**
 * Creates an in-app notification. The live poller (telemetry/livePoller.js) delivers it to /api/live,
 * like the simulator's notifications, so a toast never shows twice.
 * `svc` is the records service (passed in to avoid an import cycle).
 */
export const notifyUsers = async (
  svc,
  ctx,
  {
    userIds = [],
    title,
    description,
    module,
    recordId,
    assetId,
    plantId,
    type = 'normal',
    priority = 'medium',
  },
) =>
  svc.getModule('notifications').Model.create({
    companyId: ctx.companyId,
    plantId: plantId ?? null,
    message: { title, description },
    type,
    priority,
    details: {
      module,
      recordId: recordId ? String(recordId) : undefined,
      assetId: assetId ? String(assetId) : undefined,
    },
    recipientUsers: userIds,
    readBy: [],
  });
