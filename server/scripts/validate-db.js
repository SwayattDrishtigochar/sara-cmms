/**
 * Validates every document of a company against SARA's registry schemas (exit code 1 on errors).
 *   pnpm validate-db                   every customer company
 *   pnpm validate-db --company <id>    one company
 */
import mongoose from 'mongoose';
import { connectMongo } from '../src/config/mongo.js';
import { isObjectIdString } from '../src/lib/ids.js';
import { getModule } from '../src/modules/registry.js';
import { validateCompany } from '../src/modules/validateCompany.js';

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

/** Validates one company and returns its error count. */
const validateOne = async (company) => {
  console.log(`\nValidating ${company.name} (${company._id})`);
  const { modules, errors, warnings } = await validateCompany(company._id);
  console.table(modules.filter((m) => m.docs || m.errors || m.warnings));
  printDetails('Errors', errors);
  printDetails('Warnings', warnings);
  const errorCount = modules.reduce((sum, m) => sum + m.errors, 0);
  const warningCount = modules.reduce((sum, m) => sum + m.warnings, 0);
  console.log(
    `${errorCount ? `${errorCount} error(s)` : 'No schema errors'}` +
      (warningCount ? `, ${warningCount} warning(s)` : ''),
  );
  return errorCount;
};

const run = async () => {
  await connectMongo();
  const id = companyArg();
  const Company = getModule('companies').Model;
  const companies = id
    ? [await Company.findById(id).lean()].filter(Boolean)
    : await Company.find({ isPlatform: { $ne: true }, deleted: { $ne: true } })
        .sort({ createdAt: 1 })
        .lean();
  if (!companies.length) throw new Error(id ? `No company ${id}` : 'No companies yet');
  let errors = 0;
  for (const company of companies) errors += await validateOne(company);
  await mongoose.disconnect();
  process.exitCode = errors ? 1 : 0;
};

run().catch(async (err) => {
  console.error(err.message ?? err);
  await mongoose.disconnect();
  process.exit(1);
});
