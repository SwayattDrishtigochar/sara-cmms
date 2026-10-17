/**
 * Seeds SARA's platform tenant and superadmin. Customer companies are onboarded by the telemetry source.
 *   pnpm seed            platform tenant + superadmin
 *   pnpm seed --reset    drop the database first
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectMongo } from '../src/config/mongo.js';
import { ensureIndexes, ensurePlatform } from '../src/platform/platform.js';

const args = new Set(process.argv.slice(2));

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
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
