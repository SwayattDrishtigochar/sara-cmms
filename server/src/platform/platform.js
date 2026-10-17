import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { Counter } from '../db/models/Counter.js';
import { ParameterSpec } from '../db/models/ParameterSpec.js';
import { Session } from '../db/models/Session.js';
import { oid } from '../lib/ids.js';
import { allModules, getModule } from '../modules/registry.js';

export const PLATFORM_COMPANY_ID = oid('platform:company');

/** Idempotent: the platform tenant and the superadmin from env exist after this. */
export const ensurePlatform = async () => {
  await getModule('companies').Model.updateOne(
    { _id: PLATFORM_COMPANY_ID },
    {
      $setOnInsert: {
        name: 'Swayatt Platform',
        isPlatform: true,
        subscription: { status: 'active', currentPlan: 'enterprise' },
        features: {
          productionEnabled: false,
          energyEnabled: false,
          binTrackingEnabled: false,
          isMasterReportEnabled: false,
        },
        preferences: { timeZone: env.DEFAULT_TIMEZONE, dateFormat: 'DD-MM-YYYY', timeFormat: '12-hours' },
      },
    },
    { upsert: true },
  );
  const User = getModule('users').Model;
  const email = env.SUPERADMIN_EMAIL.toLowerCase();
  if (!(await User.exists({ email }))) {
    await User.create({
      companyId: PLATFORM_COMPANY_ID,
      firstName: 'Platform',
      lastName: 'Admin',
      email,
      password: await bcrypt.hash(env.SUPERADMIN_PASSWORD, 10),
      role: 'superAdmin',
      userTitle: 'Superadmin',
    });
  }
};

/** Builds every index (needed after a database drop). */
export const ensureIndexes = () =>
  Promise.all(
    [...allModules().map((m) => m.Model), Counter, Session, ParameterSpec].map((M) => M.createIndexes()),
  );
