import { describe, expect, it } from 'vitest';
import { evalExpr, evaluate, identifiersOf, parseExpr } from '../src/kpis/expr.js';

const scope = {
  energy: [
    { hour: '2026-10-14 10:00', kwh: 12 },
    { hour: '2026-10-14 11:00', kwh: 18 },
  ],
  parts: [{ produced: 100 }, { produced: '50' }],
  oee: 0.82,
  zero: 0,
};

describe('kpi formulas', () => {
  it('follows precedence, parentheses and unary minus', () => {
    expect(evaluate('1 + 2 * 3', {})).toBe(7);
    expect(evaluate('(1 + 2) * 3', {})).toBe(9);
    expect(evaluate('-2 * -3 + 10 % 4', {})).toBe(8);
    expect(evaluate('.5 + 1.25', {})).toBe(1.75);
  });

  it('reads scalar keys, columns and counts across sources (kWh per part)', () => {
    expect(evaluate('oee * 100', scope)).toBeCloseTo(82);
    expect(evaluate('sum(energy.kwh) / sum(parts.produced)', scope)).toBeCloseTo(0.2);
    expect(evaluate('avg(energy.kwh)', scope)).toBe(15);
    expect(evaluate('max(energy.kwh) - min(energy.kwh)', scope)).toBe(6);
    expect(evaluate('first(energy.kwh) + last(energy.kwh)', scope)).toBe(30);
    expect(evaluate('count(energy) + count(parts)', scope)).toBe(4);
    expect(evaluate('max(1, oee, 3)', scope)).toBe(3);
    expect(evaluate('round(sum(energy.kwh) / 7, 2)', scope)).toBe(4.29);
    expect(evaluate('abs(-oee)', scope)).toBe(0.82);
  });

  it('gives null for division by zero and missing numbers', () => {
    expect(evaluate('1 / zero', scope)).toBeNull();
    expect(evaluate('5 % 0', scope)).toBeNull();
    expect(evaluate('missing + 1', scope)).toBeNull();
    expect(evaluate('avg(nothing.kwh)', scope)).toBeNull();
    expect(evaluate('sum(nothing.kwh)', scope)).toBe(0);
  });

  it('lists the source keys it reads', () => {
    expect(identifiersOf(parseExpr('sum(energy.kwh) / count(parts) + oee'))).toEqual([
      'energy',
      'parts',
      'oee',
    ]);
  });

  it('reports errors with a position', () => {
    expect(() => parseExpr('1 +')).toThrow(/Formula error at 4: the formula ends too early/);
    expect(() => parseExpr('2 * (3 + 4')).toThrow(/expected "\)"/);
    expect(() => parseExpr('foo(1)')).toThrow(/Formula error at 1: unknown function "foo"/);
    expect(() => parseExpr('energy.kwh + 1')).toThrow(/works only inside sum/);
    expect(() => parseExpr('abs(energy.kwh)')).toThrow(/abs can't take a column/);
    expect(() => parseExpr('count(1)')).toThrow(/count takes one source key/);
    expect(() => parseExpr('1 2')).toThrow(/unexpected "2"/);
    expect(() => parseExpr('')).toThrow(/empty/);
    expect(() => evaluate('energy * 2', scope)).toThrow(/"energy" is a table/);
  });

  it('rejects code, oversized and deeply nested input', () => {
    for (const bad of [
      'process.exit(1)',
      'constructor.constructor("return process")()',
      'require("fs")',
      '1; 2',
      'a = 1',
      '`x`',
      '"str"',
      '[1]',
      '{}',
      'x => 1',
      '1 ** 2',
    ]) {
      expect(() => evaluate(bad, scope), bad).toThrow(/Formula error/);
    }
    expect(() => parseExpr('1+'.repeat(160))).toThrow(/at most 300 characters/);
    expect(() => parseExpr(Array(40).fill('1').join('+'))).toThrow(/at most 64 tokens/);
    expect(() => parseExpr(`${'('.repeat(12)}1${')'.repeat(12)}`)).toThrow(/nested too deeply/);
    expect(() => parseExpr(`${'-'.repeat(12)}1`)).toThrow(/nested too deeply/);
  });

  it('never reaches prototype properties', () => {
    expect(evaluate('constructor + 1', scope)).toBeNull();
    expect(evaluate('__proto__ + 1', scope)).toBeNull();
    expect(evaluate('this', scope)).toBeNull();
    expect(evalExpr(parseExpr('sum(energy.constructor) + sum(energy.__proto__)'), scope)).toBe(0);
  });
});
