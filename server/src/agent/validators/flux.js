import { bucketFor } from '../../config/influx.js';
import { badRequest } from '../../lib/errors.js';

/** Raw Flux guard for the optional `influx_flux` tool (phase 4 §3): company bucket only, read only, bounded. */
export const MAX_FLUX_CHARS = 4000;
const ALLOWED_IMPORTS = new Set(['influxdata/influxdb/schema', 'types']);
const FORBIDDEN = ['to(', 'buckets(', 'experimental', 'http.', 'sql.', 'secrets'];

/** Index of the `)` that closes the `(` at `open`, skipping string literals. */
const closingParen = (text, open) => {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  throw badRequest('Unbalanced parentheses in the Flux query');
};

/** Returns the query to run (company filter injected, limit appended) or throws a 400. */
export const validateRawFlux = (flux, ctx) => {
  if (typeof flux !== 'string' || !flux.trim()) throw badRequest('flux must be a non-empty string');
  if (flux.length > MAX_FLUX_CHARS) throw badRequest(`Flux must be ${MAX_FLUX_CHARS} characters or less`);
  const bucket = bucketFor(ctx.companyId);
  const lines = flux.trim().split('\n');
  const imports = [];
  while (lines.length && /^\s*import\b/.test(lines[0])) imports.push(lines.shift().trim());
  for (const line of imports) {
    const m = /^import\s+"([^"]+)"\s*$/.exec(line);
    if (!m || !ALLOWED_IMPORTS.has(m[1])) throw badRequest(`Import not allowed: ${line}`);
  }
  let body = lines.join('\n').trim();
  const head = `from(bucket: "${bucket}")`;
  if (!body.startsWith(head)) throw badRequest(`The query must start with ${head}`);
  // Flux allows whitespace before '(' (`to (bucket: ...)`), so the checks run on a normalised copy.
  const norm = body.replace(/\s+\(/g, '(');
  const lower = norm.toLowerCase();
  for (const bad of FORBIDDEN) {
    if (lower.includes(bad)) throw badRequest(`"${bad.replace('(', '')}" is not allowed in a query`);
  }
  if (/\bimport\b/.test(body)) throw badRequest('import is only allowed at the top of the query');
  if ((norm.match(/\brange\(/g) ?? []).length !== 1) {
    throw badRequest('The query must contain exactly one range()');
  }
  if ((norm.match(/\bfrom\(/g) ?? []).length !== 1 || (norm.match(/\bbucket(ID)?\s*:/g) ?? []).length !== 1) {
    throw badRequest('Only your own bucket can be read');
  }
  const rangeOpen = body.indexOf('(', body.search(/\brange\s*\(/));
  const close = closingParen(body, rangeOpen);
  const filter = `\n  |> filter(fn: (r) => r.companyId == "${String(ctx.companyId)}")`;
  body = body.slice(0, close + 1) + filter + body.slice(close + 1);
  if (!/\blimit\(/.test(body)) body += '\n  |> limit(n: 5000)';
  return [...imports, body].join('\n');
};
