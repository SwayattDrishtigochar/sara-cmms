/**
 * Validates every document of one company against SARA's registry schemas (exit code 1 on errors).
 *   pnpm validate-db                   the simulated company
 *   pnpm validate-db --company <id>    any company
 */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/mongo.js';
import { isObjectIdString } from '../src/lib/ids.js';
import { getModule } from '../src/modules/registry.js';
import { validateCompany } from '../src/modules/validateCompany.js';
import { simulatedCompany } from '../src/sim/simulatedCompany.js';

const SHOWN = 50;

const companyArg = () => {
  const at = process.argv.indexOf('--company');
  if (at < 0) return null;
  const id = process.argv[at + 1];
  if (!isObjectIdString(id)) throw new Error('--company needs a company id (24 hex characters)');
  return id;
};

const printDetails = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n${title}${rows.length > SHOWN ? ` (first ${SHOWN} of ${rows.length})` : ''}:`);
  for (const { module, id, path, message } of rows.slice(0, SHOWN)) {
    console.log(`  ${module}${id ? ` ${id}` : ''} · ${path}: ${message}`);
  }
};

const run = async () => {
  await connectMongo();
  const id = companyArg();
  const company = id ? await getModule('companies').Model.findById(id).lean() : await simulatedCompany();
  if (!company) {
    throw new Error(
      id ? `No company ${id}` : 'No simulated company yet: run the simulator once, or pass --company <id>',
    );
  }
  console.log(`Validating ${company.name} (${company._id})`);
  const { modules, errors, warnings } = await validateCompany(company._id);
  console.table(modules.filter((m) => m.docs || m.errors || m.warnings));
  printDetails('Errors', errors);
  printDetails('Warnings', warnings);
  const errorCount = modules.reduce((sum, m) => sum + m.errors, 0);
  const warningCount = modules.reduce((sum, m) => sum + m.warnings, 0);
  console.log(
    `\n${errorCount ? `${errorCount} error(s)` : 'No schema errors'}` +
      (warningCount ? `, ${warningCount} warning(s)` : ''),
  );
  await mongoose.disconnect();
  process.exitCode = errorCount ? 1 : 0;
};

run().catch(async (err) => {
  console.error(err.message ?? err);
  await mongoose.disconnect();
  process.exit(1);
});
