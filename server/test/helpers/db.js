import mongoose from 'mongoose';
import { connectMongo } from '../../src/config/mongo.js';
import { systemContext } from '../../src/context/buildUserContext.js';
import { generateAccount } from '../../src/sim/accountGenerator.js';
import { ensureIndexes, ensurePlatform } from '../../src/sim/platform.js';

export const PASSWORD = 'Test@12345';
export const NOW = new Date('2026-10-15T06:30:00.000Z'); // 12:00 IST, a Thursday

/** Fresh test database with the platform tenant and two seeded accounts (Acme, Beta Foods). */
export const setupDatabase = async () => {
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await ensureIndexes();
  await ensurePlatform();
  const acme = await generateAccount({
    name: 'Acme Components',
    slug: 'acme',
    domain: 'acme.test',
    password: PASSWORD,
    withHistory: true,
    now: NOW,
  });
  const beta = await generateAccount({
    name: 'Beta Foods',
    slug: 'betafoods',
    domain: 'beta.test',
    plantNames: ['Nashik'],
    features: { productionEnabled: false, energyEnabled: true, binTrackingEnabled: false },
    password: PASSWORD,
    withHistory: true,
    now: NOW,
  });
  return { acme, beta };
};

export const teardownDatabase = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
};

/** A request-like context for a seeded user, built the same way the auth middleware does. */
export const contextFor = async (email) => {
  const { buildUserContext } = await import('../../src/context/buildUserContext.js');
  const { getModule } = await import('../../src/modules/registry.js');
  const user = await getModule('users').Model.findOne({ email }).lean();
  if (!user) throw new Error(`No seeded user ${email}`);
  return buildUserContext(user);
};

export { systemContext };
