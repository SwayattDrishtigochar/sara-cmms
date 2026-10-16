/**
 * Seeds SARA. The simulated plant company comes from sara-simulator on its first run.
 *   pnpm seed                    platform tenant + superadmin only
 *   pnpm seed --demo             also the generated test accounts (Acme Demo, Beta Foods); their slugs and
 *                                domains differ from the simulator's company, so both can share a database
 *   pnpm seed --demo --history   … with downtime/rejection history (when no simulator runs)
 *   pnpm seed --reset            drop the database first
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectMongo } from '../src/config/mongo.js';
import { generateAccount } from '../src/sim/accountGenerator.js';
import { ensureIndexes, ensurePlatform } from '../src/sim/platform.js';

const args = new Set(process.argv.slice(2));

const DEMO_ACCOUNTS = [
  {
    name: 'Acme Demo',
    slug: 'acme-demo',
    domain: `demo.${env.SIM_DEFAULT_DOMAIN}`,
    plantNames: ['Pune', 'Chennai'],
  },
  {
    name: 'Beta Foods',
    slug: 'betafoods',
    domain: `betafoods.${env.SIM_DEFAULT_DOMAIN}`,
    industry: 'Food processing',
    location: 'Nashik, Maharashtra',
    plantNames: ['Nashik'],
    features: {
      productionEnabled: false,
      energyEnabled: true,
      binTrackingEnabled: false,
      isMasterReportEnabled: false,
    },
  },
];

const run = async () => {
  await connectMongo();
  const dbName = mongoose.connection.db.databaseName;
  if (args.has('--reset')) {
    await mongoose.connection.dropDatabase();
    console.log(`Dropped database "${dbName}"`);
  }
  await ensureIndexes();
  await ensurePlatform();
  console.log(`Superadmin: ${env.SUPERADMIN_EMAIL} (password: SUPERADMIN_PASSWORD in .env)`);

  if (args.has('--demo')) {
    for (const account of DEMO_ACCOUNTS) {
      const result = await generateAccount({
        ...account,
        password: env.SIM_DEFAULT_PASSWORD,
        withHistory: args.has('--history'),
      });
      console.log(`\n${result.name}: ${JSON.stringify(result.counts)}`);
      console.table(
        result.credentials.map(({ email, role, title, plant }) => ({ email, role, title, plant })),
      );
    }
    console.log(`\nAll generated users sign in with: ${env.SIM_DEFAULT_PASSWORD}`);
  }
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
