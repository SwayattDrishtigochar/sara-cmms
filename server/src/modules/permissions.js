import { forbidden } from '../lib/errors.js';

/** Keys of the technician `permissions` map ({ add, update, delete } each), as in CMMS plus SARA's production keys. */
export const PERMISSION_KEYS = [
  'work-order',
  'preventive-maintenance',
  'calibration',
  'assets',
  'spare-part',
  'sparepart-inventory',
  'consumables',
  'maintenance-job-request',
  'plant',
  'vendor',
  'supplier',
  'checklist',
  'production',
  'tools',
  'quality',
  'rules',
];

export const ROLES = ['owner', 'admin', 'technician', 'view', 'superAdmin'];
const FULL_ACCESS = new Set(['owner', 'admin', 'superAdmin', 'system']);

/** Which roles each role may give to another user. Nobody may change their own role. */
const GRANTABLE = {
  system: ROLES,
  superAdmin: ROLES,
  owner: ['admin', 'technician', 'view'],
  admin: ['technician', 'view'],
};

/** Can `ctx` perform `action` (read | create | update | delete) on module `mod`? */
export const can = (ctx, mod, action) => {
  if (FULL_ACCESS.has(ctx.role)) return true;
  if (action === 'read') return ctx.role === 'technician' || ctx.role === 'view';
  if (ctx.role !== 'technician' || !mod.permissionKey) return false;
  const perms = ctx.permissions?.[mod.permissionKey];
  return Boolean(perms?.[action === 'create' ? 'add' : action]);
};

export const assertCan = (ctx, mod, action) => {
  if (!can(ctx, mod, action)) {
    throw forbidden(`Your role (${ctx.role}) can't ${action} ${mod.label.toLowerCase()}`);
  }
};

export const canGrant = (ctx, role) => (GRANTABLE[ctx.role] ?? []).includes(role);

export const assertGrantable = (ctx, role) => {
  if (!canGrant(ctx, role)) throw forbidden(`Your role (${ctx.role}) can't assign the ${role} role`);
};

/** Admins manage technicians and viewers only; owners manage everyone but other owners. */
export const canManageUser = (ctx, target) => {
  if (ctx.role === 'superAdmin' || ctx.role === 'system') return true;
  if (String(target._id) === String(ctx.userId)) return true;
  return canGrant(ctx, target.role);
};

/** A technician permission map with every flag set to `value`. */
export const permissionMap = (value = false) =>
  Object.fromEntries(PERMISSION_KEYS.map((k) => [k, { add: value, update: value, delete: value }]));
