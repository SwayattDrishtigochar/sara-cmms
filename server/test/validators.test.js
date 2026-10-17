import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { validateRawFlux } from '../src/agent/validators/flux.js';
import { MAX_DEPTH, sanitizeFilter } from '../src/agent/validators/mongoFilter.js';
import { MAX_GROUPED, sanitizePipeline } from '../src/agent/validators/mongoPipeline.js';
import { redact } from '../src/agent/validators/redact.js';
import { env } from '../src/config/env.js';
import { scopeFilter } from '../src/modules/records.js';
import { getModule } from '../src/modules/registry.js';

const { ObjectId } = mongoose.Types;
const companyId = new ObjectId();
const plantId = new ObjectId();
const ctx = { companyId, plantLock: null, modules: ['workorders', 'assets', 'users', 'downtimes'] };
const locked = { ...ctx, plantLock: plantId };
const wo = getModule('workorders');
const users = getModule('users');
const f = (filter, mod = wo) => sanitizeFilter(filter, { mod, ctx });
const p = (pipeline, c = ctx, mod = wo) => sanitizePipeline(pipeline, { mod, ctx: c }).pipeline;
const HEX = '64b7f0c2a1b2c3d4e5f60718';

describe('sanitizeFilter', () => {
  it('keeps allow-listed operators and plain equality', () => {
    const out = f({
      workStatus: { $in: ['Open', 'In Progress'] },
      priority: 'High',
      $or: [{ name: { $exists: true } }],
    });
    expect(out).toEqual({
      workStatus: { $in: ['Open', 'In Progress'] },
      priority: 'High',
      $or: [{ name: { $exists: true } }],
    });
  });

  it.each(['$where', '$function', '$accumulator', '$expr', '$jsonSchema', '$text', '$near', '$nearSphere'])(
    'rejects %s anywhere',
    (op) => {
      expect(() => f({ [op]: 'x' })).toThrow(/not allowed/);
      expect(() => f({ name: { [op]: 'x' } })).toThrow(/not allowed/);
      expect(() => f({ $and: [{ name: { [op]: 1 } }] })).toThrow(/not allowed/);
    },
  );

  it('rejects unknown operators and $-keys outside operator position', () => {
    expect(() => f({ name: { $foo: 1 } })).toThrow(/Unknown operator/);
    expect(() => f({ $in: [1] })).toThrow(/must sit under a field/);
    expect(() => f({ name: { $eq: 1, plain: 2 } })).toThrow(/mix fields and operators/);
  });

  it('rejects prototype pollution keys', () => {
    expect(() => f(JSON.parse('{"__proto__": {"x": 1}}'))).toThrow(/__proto__/);
    expect(() => f({ constructor: 1 })).toThrow(/constructor/);
    expect(() => f({ name: { prototype: 1 } })).toThrow();
    expect(() => f({ trackProcess: JSON.parse('{"__proto__": 1}') })).toThrow(/__proto__/);
  });

  it('drops tenant keys at any depth (the session tenant is re-injected by the caller)', () => {
    const other = new ObjectId().toHexString();
    const out = f({
      companyId: other,
      company: other,
      $or: [{ companyId: other, name: 'x' }],
      trackProcess: { companyId: other },
    });
    expect(JSON.stringify(out)).not.toContain(other);
    expect(out).toEqual({ $or: [{ name: 'x' }], trackProcess: {} });
    const { pipeline } = sanitizePipeline([{ $match: { companyId: other } }], { mod: wo, ctx });
    expect(pipeline[0]).toEqual({ $match: { companyId, deleted: { $ne: true } } });
    expect(pipeline[1]).toEqual({ $match: {} });
  });

  it('bounds regexes: length, nested quantifiers, options, validity', () => {
    expect(f({ name: { $regex: 'bearing' } })).toEqual({ name: { $regex: 'bearing', $options: 'i' } });
    expect(f({ name: { $regex: '^pump', $options: 'm' } }).name.$options).toBe('m');
    expect(() => f({ name: { $regex: 'a'.repeat(201) } })).toThrow(/200/);
    for (const evil of ['(a+)+', '(a*)*b', '(\\d+){2,}', '(x+x+)+y', 'a++']) {
      expect(() => f({ name: { $regex: evil } }), evil).toThrow(/nested quantifiers/);
    }
    expect(() => f({ name: { $regex: 'x', $options: 'g' } })).toThrow(/\$options/);
    expect(() => f({ name: { $regex: '(' } })).toThrow(/not a valid/);
    expect(() => f({ name: { $regex: { $gt: 1 } } })).toThrow(/string/);
    expect(() => f({ name: { $options: 'i' } })).toThrow(/needs a \$regex/);
  });

  it('casts ids and dates from the registry, including dotted paths and arrays', () => {
    const out = f({
      _id: HEX,
      asset: HEX,
      people: { $in: [HEX] },
      dueDate: { $gte: '2026-10-01T00:00:00Z' },
      'comments.createdAt': { $lt: '2026-10-02' },
      'spareParts.sparePart': HEX,
    });
    expect(out._id).toBeInstanceOf(ObjectId);
    expect(out.asset).toBeInstanceOf(ObjectId);
    expect(out.people.$in[0]).toBeInstanceOf(ObjectId);
    expect(out.dueDate.$gte).toBeInstanceOf(Date);
    expect(out['spareParts.sparePart']).toBeInstanceOf(ObjectId);
    expect(f({ name: HEX }).name).toBe(HEX); // free text stays a string
    expect(f({ dueDate: 'tomorrow' }).dueDate).toBe('tomorrow');
  });

  it('accepts extended JSON, dd-mm-yyyy dates and numeric strings the model writes', () => {
    const out = f({
      dueDate: { $gte: { $date: '2026-10-01T00:00:00Z' } },
      createdAt: { $lt: '15-10-2026' },
      updatedAt: { $date: { $numberLong: '1760000000000' } },
      asset: { $oid: HEX },
      people: { $in: [{ $oid: HEX }] },
      'spareParts.plannedQuantity': { $gt: { $numberInt: '2' } },
    });
    expect(out.dueDate.$gte).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(out.createdAt.$lt).toBeInstanceOf(Date);
    expect(Math.abs(out.createdAt.$lt - new Date('2026-10-15T00:00:00Z'))).toBeLessThan(86_400_000);
    expect(out.updatedAt).toEqual(new Date(1760000000000));
    expect(out.asset).toBeInstanceOf(ObjectId);
    expect(out.people.$in[0]).toBeInstanceOf(ObjectId);
    expect(out['spareParts.plannedQuantity'].$gt).toBe(2);
    // an unknown field still takes { $date } (the audit had "date" on a module without that spec)
    expect(f({ date: { $gte: { $date: '2026-10-01T00:00:00Z' } } }).date.$gte).toBeInstanceOf(Date);
    // other objects in value position are still refused
    expect(() => f({ dueDate: { $gte: { nested: 1 } } })).toThrow(/plain value/);
    const stages = p([{ $addFields: { late: { $lt: ['$dueDate', { $date: '2026-10-01T00:00:00Z' }] } } }]);
    expect(stages.at(-2).$addFields.late.$lt[1]).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('does not let an extended JSON wrapper hide a banned operator', () => {
    const fn = { $function: { body: 'function () {}', args: [], lang: 'js' } };
    expect(() => p([{ $addFields: { x: { $oid: fn } } }])).toThrow(/not allowed/);
    expect(() => p([{ $group: { _id: null, v: { $date: { $accumulator: {} } } } }])).toThrow(/not allowed/);
    expect(() => p([{ $project: { v: { $numberLong: fn } } }])).toThrow(/not allowed/);
    expect(() => f({ asset: { $oid: { $where: 'x' } } })).toThrow(/plain value|not allowed/);
    expect(() => f({ asset: { $in: [{ $oid: { $where: 'x' } }] } })).toThrow(/plain value|not allowed/);
  });

  it('casts inside $elemMatch', () => {
    const out = f({ spareParts: { $elemMatch: { sparePart: HEX, plannedQuantity: { $gt: '2' } } } });
    expect(out.spareParts.$elemMatch.sparePart).toBeInstanceOf(ObjectId);
    expect(out.spareParts.$elemMatch.plannedQuantity.$gt).toBe(2);
  });

  it('refuses secret fields and non-plain values', () => {
    expect(() => f({ password: 'x' }, users)).toThrow(/Can't filter/);
    expect(() => f([])).toThrow(/plain object/);
    expect(() => f({ name: { $in: 'x' } })).toThrow(/array/);
    expect(() => f({ name: { $eq: { nested: 1 } } })).toThrow(/plain value/);
  });

  it(`limits nesting to ${MAX_DEPTH} levels`, () => {
    let deep = { name: 'x' };
    for (let i = 0; i < MAX_DEPTH + 1; i++) deep = { $and: [deep] };
    expect(() => f(deep)).toThrow(/nested too deeply/);
    let ok = { name: 'x' };
    for (let i = 0; i < 3; i++) ok = { $and: [ok] };
    expect(() => f(ok)).not.toThrow();
  });

  it('does not mutate the input', () => {
    const input = { companyId: 'x', asset: HEX };
    f(input);
    expect(input).toEqual({ companyId: 'x', asset: HEX });
  });
});

describe('sanitizePipeline', () => {
  it('forces the scope first and caps the output', () => {
    const out = p([{ $match: { priority: 'High' } }]);
    expect(out[0]).toEqual({ $match: { companyId, deleted: { $ne: true } } });
    expect(out.at(-1)).toEqual({ $limit: env.MAX_ROWS });
    const plant = p([{ $sort: { dueDate: -1 } }], locked);
    expect(plant[0].$match.plantId).toEqual(plantId);
  });

  it('projects secrets away on modules that have them', () => {
    expect(p([{ $sort: { name: 1 } }], ctx, users)[1]).toEqual({ $project: { password: 0 } });
  });

  it('caps grouped output at 1000 and respects a trailing $count / $limit', () => {
    expect(p([{ $group: { _id: '$priority', n: { $sum: 1 } } }]).at(-1)).toEqual({ $limit: MAX_GROUPED });
    expect(p([{ $sortByCount: '$priority' }]).at(-1)).toEqual({ $limit: MAX_GROUPED });
    expect(p([{ $count: 'n' }]).at(-1)).toEqual({ $count: 'n' });
    expect(p([{ $limit: 5000 }]).at(-1)).toEqual({ $limit: MAX_GROUPED });
    expect(() => p([{ $limit: 0 }])).toThrow(/at least 1/);
  });

  it.each([
    '$out',
    '$merge',
    '$unionWith',
    '$graphLookup',
    '$collStats',
    '$indexStats',
    '$currentOp',
    '$planCacheStats',
  ])('rejects stage %s', (stage) => {
    expect(() => p([{ [stage]: {} }])).toThrow(/not allowed/);
  });

  it('rejects unknown stages and malformed stages', () => {
    expect(() => p([{ $densify: {} }])).toThrow(/Unsupported stage/);
    expect(() => p([{ $match: {}, $sort: {} }])).toThrow(/exactly one/);
    expect(() => p({})).toThrow(/array/);
  });

  it('rejects banned operators deep inside expressions', () => {
    expect(() => p([{ $group: { _id: null, x: { $accumulator: { init: 'function(){}' } } } }])).toThrow(
      /\$accumulator/,
    );
    expect(() => p([{ $addFields: { y: { $function: { body: 'x', args: [], lang: 'js' } } } }])).toThrow(
      /\$function/,
    );
    expect(() => p([{ $project: { a: { $where: '1' } } }])).toThrow(/\$where/);
    expect(() => p([{ $set: JSON.parse('{"__proto__": {"a": 1}}') }])).toThrow(/__proto__/);
  });

  it('sanitises $match inside $facet sub-pipelines and rejects banned stages there', () => {
    const out = p([
      { $facet: { open: [{ $match: { companyId: 'x', workStatus: 'Open' } }, { $count: 'n' }] } },
    ]);
    expect(out[1].$facet.open[0]).toEqual({ $match: { workStatus: 'Open' } });
    expect(out.at(-1)).toEqual({ $limit: MAX_GROUPED });
    expect(() => p([{ $facet: { x: [{ $out: 'evil' }] } }])).toThrow(/not allowed/);
    expect(() => p([{ $facet: { x: [{ $facet: { y: [{ $merge: 'evil' }] } }] } }])).toThrow(/not allowed/);
    expect(() => p([{ $facet: { x: [{ $match: { $where: '1' } }] } }])).toThrow(/not allowed/);
  });

  it('rewrites $lookup with the tenant match and secret projection', () => {
    const out = p([{ $lookup: { from: 'users', localField: 'people', foreignField: '_id', as: 'who' } }]);
    expect(out[1].$lookup).toEqual({
      from: 'users',
      localField: 'people',
      foreignField: '_id',
      as: 'who',
      pipeline: [{ $match: scopeFilter(ctx, users) }, { $project: { password: 0 } }],
    });
  });

  it('keeps the plant lock and soft delete inside a join, even one on the tenant field', () => {
    const join = { from: 'workorders', localField: 'companyId', foreignField: 'companyId', as: 'all' };
    const out = sanitizePipeline([{ $limit: 1 }, { $lookup: join }], {
      mod: getModule('assets'),
      ctx: locked,
    }).pipeline;
    expect(out.find((st) => st.$lookup).$lookup.pipeline[0]).toEqual({
      $match: { companyId, deleted: { $ne: true }, plantId },
    });
  });

  it('bounds regexes of $regexMatch / $regexFind / $regexFindAll', () => {
    const re = (op, regex, options) => [
      { $addFields: { x: { [op]: { input: '$description', regex, ...(options ? { options } : {}) } } } },
    ];
    for (const op of ['$regexMatch', '$regexFind', '$regexFindAll']) {
      expect(() => p(re(op, '(a+)+$')), op).toThrow(/nested quantifiers/);
      expect(() => p(re(op, 'x'.repeat(201))), op).toThrow(/200/);
      expect(() => p(re(op, 'leak', 'g')), op).toThrow(/options/);
      expect(() => p(re(op, { $concat: ['a'] })), op).toThrow(/must be a string/);
      expect(() => p(re(op, 'leak', 'i')), op).not.toThrow();
    }
  });

  it('rejects $lookup outside the company modules or with a custom pipeline', () => {
    expect(() =>
      p([{ $lookup: { from: 'companies', localField: 'a', foreignField: '_id', as: 'c' } }]),
    ).toThrow(/Can't join/);
    expect(() =>
      p([{ $lookup: { from: 'users', localField: 'a', foreignField: '_id', as: 'u', pipeline: [] } }]),
    ).toThrow(/only supports/);
    expect(() => p([{ $lookup: { from: 'users', as: 'u' } }])).toThrow(/localField/);
  });
});

describe('redact', () => {
  it('drops secret keys recursively and converts ids and dates', () => {
    const id = new ObjectId();
    const at = new Date('2026-10-15T00:00:00Z');
    const out = redact({
      _id: id,
      name: 'Ramesh',
      password: 'hash',
      token: 't',
      nested: { keyHash: 'k', auth: 'a', p256dh: 'p', ok: at, list: [{ otp: '1', secret: 's', keep: 1 }] },
      credentials: {},
      headers: {},
    });
    expect(out).toEqual({
      _id: String(id),
      name: 'Ramesh',
      nested: { ok: at.toISOString(), list: [{ keep: 1 }] },
    });
  });
});

describe('validateRawFlux', () => {
  const bucket = String(companyId);
  const ok = `from(bucket: "${bucket}")\n  |> range(start: -1h)\n  |> filter(fn: (r) => r._measurement == "energy")`;

  it('pins the company filter right after range and appends a limit', () => {
    const out = validateRawFlux(ok, ctx);
    expect(out).toContain(`|> range(start: -1h)\n  |> filter(fn: (r) => r.companyId == "${bucket}")`);
    expect(out.endsWith('|> limit(n: 5000)')).toBe(true);
    expect(validateRawFlux(`${ok}\n  |> limit(n: 10)`, ctx).match(/limit\(/g)).toHaveLength(1);
  });

  it('allows only the schema and types imports at the top', () => {
    expect(() => validateRawFlux(`import "influxdata/influxdb/schema"\n${ok}`, ctx)).not.toThrow();
    expect(() => validateRawFlux(`import "http"\n${ok}`, ctx)).toThrow(/Import not allowed/);
    expect(() => validateRawFlux(`${ok}\nimport "types"`, ctx)).toThrow(/import/);
  });

  it('rejects other buckets, writes and escapes', () => {
    expect(() => validateRawFlux(ok.replace(bucket, 'someone-else'), ctx)).toThrow(/must start with/);
    expect(() => validateRawFlux(`${ok}\n  |> to(bucket: "${bucket}")`, ctx)).toThrow(/not allowed/);
    expect(() =>
      validateRawFlux(`${ok}\n  |> union(tables: [from(bucket: "other") |> range(start: -1h)])`, ctx),
    ).toThrow();
    expect(() => validateRawFlux(`${ok}\nbuckets()`, ctx)).toThrow(/buckets/);
    // Flux allows whitespace before '(' and a bucketID: source
    expect(() => validateRawFlux(`${ok}\n  |> to (bucket: "x")`, ctx)).toThrow(/not allowed/);
    expect(() => validateRawFlux(`${ok}\nbuckets ()`, ctx)).toThrow(/buckets/);
    expect(() =>
      validateRawFlux(`${ok}\n  |> union(tables: [from (bucketID: "abc") |> range (start: -1h)])`, ctx),
    ).toThrow();
    expect(() => validateRawFlux(`${ok}\n  |> yield(name: from(bucketID: "abc"))`, ctx)).toThrow(/bucket/);
    for (const bad of ['experimental.foo()', 'http.post()', 'sql.from()', 'secrets.get(key: "x")']) {
      expect(() => validateRawFlux(`${ok}\n${bad}`, ctx), bad).toThrow(/not allowed/);
    }
  });

  it('needs exactly one range and stays under the size limit', () => {
    expect(() => validateRawFlux(`from(bucket: "${bucket}") |> filter(fn: (r) => true)`, ctx)).toThrow(
      /range/,
    );
    expect(() => validateRawFlux(`${ok}\n  |> range(start: -2h)`, ctx)).toThrow(/range/);
    expect(() => validateRawFlux(`${ok}\n  |> range (start: -2h)`, ctx)).toThrow(/range/);
    expect(validateRawFlux(ok.replace('range(', 'range ('), ctx)).toContain(
      `|> range (start: -1h)\n  |> filter(fn: (r) => r.companyId == "${bucket}")`,
    );
    expect(() => validateRawFlux(`${ok}${' '.repeat(4000)}`, ctx)).toThrow(/4000/);
    expect(() => validateRawFlux('', ctx)).toThrow();
  });
});
