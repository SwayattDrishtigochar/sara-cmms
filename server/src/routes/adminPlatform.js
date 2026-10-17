import { Router } from 'express';
import { requireSuperAdmin } from '../auth/middleware.js';
import { getModule } from '../modules/registry.js';

/** Superadmin's read-only view of the platform: every customer company with its headline counts. */
export const adminPlatformRouter = Router();
adminPlatformRouter.use(requireSuperAdmin);

/** { <companyId>: number } of live documents of a module. */
const countsByCompany = async (module) => {
  const rows = await getModule(module).Model.aggregate([
    { $match: { deleted: { $ne: true } } },
    { $group: { _id: '$companyId', n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
};

adminPlatformRouter.get('/companies', async (_req, res) => {
  const [companies, plants, users, assets] = await Promise.all([
    getModule('companies')
      .Model.find({ isPlatform: { $ne: true }, deleted: { $ne: true } })
      .select('name createdAt')
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
    countsByCompany('plants'),
    countsByCompany('users'),
    countsByCompany('assets'),
  ]);
  res.json({
    companies: companies.map((c) => {
      const id = String(c._id);
      return {
        id,
        name: c.name,
        plants: plants[id] ?? 0,
        users: users[id] ?? 0,
        assets: assets[id] ?? 0,
        createdAt: c.createdAt ?? null,
      };
    }),
  });
});
