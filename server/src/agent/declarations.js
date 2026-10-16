import { z } from 'zod';

const INT_BOUND = 2 ** 53 - 1;
const DROP = new Set(['$schema', 'propertyNames', 'default', 'additionalItems', 'additionalProperties']);
const SCHEMA_CHILDREN = new Set(['items', 'not']);
const SCHEMA_LISTS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

/** JSON Schema from zod, trimmed to what Gemini's `parametersJsonSchema` / `responseJsonSchema` accept. */
const clean = (node) => {
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (DROP.has(key)) continue;
    if ((key === 'minimum' || key === 'maximum') && Math.abs(value) >= INT_BOUND) continue;
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child)]));
      continue;
    }
    if (SCHEMA_CHILDREN.has(key)) out[key] = clean(value);
    else if (SCHEMA_LISTS.has(key)) out[key] = value.map(clean);
    else out[key] = value;
  }
  const freeForm = !out.properties || !Object.keys(out.properties).length;
  if (out.type === 'object' && freeForm) delete out.properties; // `{ type: 'object' }` is the free-form shape
  if (out.type === 'object' && !freeForm && node.additionalProperties === false)
    out.additionalProperties = false;
  if (Array.isArray(out.type) && out.type.includes('null')) {
    const rest = out.type.filter((t) => t !== 'null');
    out.type = rest.length === 1 ? rest[0] : rest;
    out.nullable = true;
  }
  return out;
};

/** Cleaned JSON Schema of any zod schema (tool parameters, structured router/title responses). */
export const toJsonSchema = (schema) =>
  clean(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }));

/** Gemini function declaration of a tool: `{ name, description, parametersJsonSchema }`. */
export const toDeclaration = (tool) => {
  const schema = toJsonSchema(tool.schema);
  if (schema.type !== 'object') throw new Error(`Tool "${tool.name}" must take an object`);
  return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
};
