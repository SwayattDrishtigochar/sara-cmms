import { describe, expect, it } from 'vitest';
import { digestFields, toZodObject } from '../src/modules/fields.js';
import { getModule } from '../src/modules/registry.js';

const fields = {
  name: { type: 'string', required: true },
  priority: { type: 'enum', values: ['Low', 'High'], default: 'Low' },
  asset: { type: 'ref', ref: 'assets' },
  qty: { type: 'number', min: 0 },
  due: { type: 'date' },
  status: { type: 'string', readOnly: true },
  password: { type: 'string', secret: true },
  rows: {
    type: 'array',
    of: { part: { type: 'ref', ref: 'spareparts', required: true }, n: { type: 'number' } },
  },
};

describe('field DSL → zod', () => {
  it('requires required fields on create but not on update', () => {
    expect(toZodObject(fields).safeParse({}).success).toBe(false);
    expect(toZodObject(fields, { partial: true }).safeParse({}).success).toBe(true);
  });

  it('rejects read-only and unknown keys (strict)', () => {
    const create = toZodObject(fields);
    expect(create.safeParse({ name: 'x', status: 'Closed' }).success).toBe(false);
    expect(create.safeParse({ name: 'x', hacker: 1 }).success).toBe(false);
  });

  it('leaves secret fields out of agent schemas', () => {
    expect(toZodObject(fields).safeParse({ name: 'x', password: 'p' }).success).toBe(true);
    expect(toZodObject(fields, { allowSecret: false }).safeParse({ name: 'x', password: 'p' }).success).toBe(
      false,
    );
  });

  it('validates ids, coerces numbers and dates, accepts null to clear optional fields', () => {
    const create = toZodObject(fields);
    expect(create.safeParse({ name: 'x', asset: 'not-an-id' }).success).toBe(false);
    const ok = create.parse({ name: 'x', qty: '3', due: '2026-10-20', asset: null });
    expect(ok.qty).toBe(3);
    expect(ok.due).toBeInstanceOf(Date);
    expect(ok.asset).toBeNull();
    expect(create.safeParse({ name: 'x', qty: -1 }).success).toBe(false);
  });

  it('validates nested rows strictly', () => {
    const create = toZodObject(fields);
    expect(create.safeParse({ name: 'x', rows: [{ n: 1 }] }).success).toBe(false);
    expect(create.safeParse({ name: 'x', rows: [{ part: 'a'.repeat(24), n: 1 }] }).success).toBe(true);
  });

  it('builds a compact digest with enums, refs and required marks', () => {
    const digest = digestFields(fields);
    expect(digest).toContain('name!');
    expect(digest).toContain('priority[Low|High]');
    expect(digest).toContain('asset→assets');
    expect(digest).not.toContain('password');
  });
});

describe('registry', () => {
  it('hides secrets from queries and agent writes', () => {
    const users = getModule('users');
    expect(users.Model.schema.path('password').options.select).toBe(false);
    expect('password' in users.agentCreateSchema.shape).toBe(false);
    expect(users.agentWritable).toBe(false);
  });

  it('keeps work order status out of generic writes', () => {
    const wo = getModule('workorders');
    expect('workStatus' in wo.createSchema.shape).toBe(false);
    expect(wo.actions.status.schema.safeParse({ workStatus: 'Completed' }).success).toBe(true);
  });
});
