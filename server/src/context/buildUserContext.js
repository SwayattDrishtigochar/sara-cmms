import { IANAZone } from 'luxon';
import { env } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { can } from '../modules/permissions.js';
import { getModule, modulesFor } from '../modules/registry.js';

/** Roles that see every plant of the company (CMMS getPlantFilter: everyone else is locked to their plant). */
const COMPANY_WIDE_ROLES = new Set(['owner', 'superAdmin', 'system']);

export const resolveTimeZone = (company) => {
  const tz = company?.preferences?.timeZone;
  return tz && tz !== 'GMT' && IANAZone.isValidZone(tz) ? tz : env.DEFAULT_TIMEZONE;
};

const companySummary = (company) => ({
  id: String(company._id),
  name: company.name,
  industry: company.industry,
  timeZone: resolveTimeZone(company),
  dateFormat: company.preferences?.dateFormat ?? 'DD-MM-YYYY',
  timeFormat: company.preferences?.timeFormat ?? '12-hours',
  currency: {
    name: company.preferences?.currency?.name ?? 'INR',
    symbol: company.preferences?.currency?.symbol ?? '₹',
  },
  features: company.features ?? {},
  isPlatform: Boolean(company.isPlatform),
});

const loadCompany = async (companyId) => {
  const [company, plants] = await Promise.all([
    getModule('companies').Model.findById(companyId).lean(),
    getModule('plants')
      .Model.find({ companyId, deleted: { $ne: true } })
      .select('name plantCode location shifts runningSchedule holidays energyData')
      .sort({ name: 1 })
      .lean(),
  ]);
  if (!company) throw unauthorized('Your company account no longer exists');
  return { company, plants };
};

/**
 * Everything a request needs to know about who is asking: tenant, plant lock, role,
 * permissions, company preferences and the modules their company has switched on.
 */
export const buildUserContext = async (user) => {
  const { company, plants } = await loadCompany(user.companyId);
  const plantId = user.plantId ?? null;
  const ctx = {
    userId: user._id,
    companyId: company._id,
    plantId,
    plantLock: COMPANY_WIDE_ROLES.has(user.role) ? null : plantId,
    role: user.role,
    department: user.department,
    permissions: user.permissions ?? {},
    user: {
      id: String(user._id),
      name: [user.firstName, user.lastName].filter(Boolean).join(' '),
      email: user.email,
      title: user.userTitle,
    },
    company: companySummary(company),
    plants,
  };
  ctx.modules = modulesFor(ctx).map((m) => m.name);
  return ctx;
};

/** Context for server-side jobs (AI scans, generators): full rights, no plant lock. */
export const systemContext = async (companyId) => {
  const { company, plants } = await loadCompany(companyId);
  const ctx = {
    userId: null,
    companyId: company._id,
    plantId: null,
    plantLock: null,
    role: 'system',
    permissions: {},
    user: { id: null, name: 'SARA', email: null },
    company: companySummary(company),
    plants,
  };
  ctx.modules = modulesFor(ctx).map((m) => m.name);
  return ctx;
};

/** The part of the context the web app receives. */
export const publicContext = (ctx) => ({
  user: ctx.user,
  role: ctx.role,
  department: ctx.department,
  plantId: ctx.plantId ? String(ctx.plantId) : null,
  plantLocked: Boolean(ctx.plantLock),
  company: ctx.company,
  plants: ctx.plants.map((p) => ({
    _id: String(p._id),
    name: p.name,
    plantCode: p.plantCode,
    shifts: p.shifts,
    runningSchedule: p.runningSchedule,
  })),
  modules: ctx.modules,
  can: Object.fromEntries(
    ctx.modules.map((name) => {
      const mod = getModule(name);
      return [
        name,
        { create: can(ctx, mod, 'create'), update: can(ctx, mod, 'update'), delete: can(ctx, mod, 'delete') },
      ];
    }),
  ),
});
