import { EventEmitter } from 'node:events';

// ponytail: in-process event bus, single server instance; swap for Redis pub/sub to scale out.
const bus = new EventEmitter();
bus.setMaxListeners(0);

/**
 * Publishes a live event to every subscriber of the company.
 * `audience` narrows delivery: { plantId } (plant-scoped users), { userIds } or { superAdmin: true }.
 */
export const publish = (companyId, type, payload, audience = {}) => {
  bus.emit('event', { companyId: String(companyId), type, payload, audience, at: Date.now() });
};

export const subscribe = (handler) => {
  bus.on('event', handler);
  return () => bus.off('event', handler);
};

/**
 * Audience of a record that lives in a plant. A null plant still names one: plant-locked users can't
 * see company-wide records, so only company-wide roles get the event.
 */
export const plantAudience = (plantId) => ({ plantId: plantId ? String(plantId) : null });
