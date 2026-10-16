import { badRequest } from '../lib/errors.js';

/**
 * KPI formulas (docs/phase5-contracts.md §3.8): a tiny recursive-descent parser and evaluator. No eval, no
 * Function, no property access beyond `KEY.FIELD` on source rows. Values are numbers or rows (arrays).
 */

/** A source key: what formulas and encodings call a KPI source. */
export const KEY_PATTERN = /^[a-z][A-Za-z0-9_]{0,19}$/;
const MAX_CHARS = 300;
const MAX_TOKENS = 64;
const MAX_DEPTH = 10;
const FUNCS = new Set(['sum', 'avg', 'min', 'max', 'count', 'first', 'last', 'round', 'abs']);
const COLUMN_FUNCS = new Set(['sum', 'avg', 'min', 'max', 'first', 'last']);
const TOKEN = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/%(),.]))/y;

const fail = (pos, message) => badRequest(`Formula error at ${pos + 1}: ${message}`);

const tokenize = (text) => {
  const tokens = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) {
      const pos = start + (text.slice(start).length - text.slice(start).trimStart().length);
      throw fail(pos, `unexpected "${text[pos]}"`);
    }
    const pos = TOKEN.lastIndex - m[0].trimStart().length;
    if (m[1]) tokens.push({ t: 'num', v: Number(m[1]), pos });
    else if (m[2]) tokens.push({ t: 'id', v: m[2], pos });
    else tokens.push({ t: m[3], pos });
    if (tokens.length > MAX_TOKENS) throw fail(pos, `too long (at most ${MAX_TOKENS} tokens)`);
  }
  return tokens;
};

/** Parses a formula into an AST; throws a 400 `Formula error at <pos>: …`. */
export const parseExpr = (text) => {
  const src = String(text ?? '');
  if (!src.trim()) throw fail(0, 'the formula is empty');
  if (src.length > MAX_CHARS) throw fail(MAX_CHARS, `too long (at most ${MAX_CHARS} characters)`);
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const posOf = () => peek()?.pos ?? src.length;
  const expect = (t) => {
    if (peek()?.t !== t) throw fail(posOf(), `expected "${t}"`);
    i++;
  };

  const expr = (depth) => {
    if (depth > MAX_DEPTH) throw fail(posOf(), `nested too deeply (at most ${MAX_DEPTH} levels)`);
    let node = term(depth);
    while (peek()?.t === '+' || peek()?.t === '-') {
      const op = tokens[i++].t;
      node = { type: 'bin', op, left: node, right: term(depth) };
    }
    return node;
  };
  const term = (depth) => {
    let node = unary(depth);
    while (['*', '/', '%'].includes(peek()?.t)) {
      const op = tokens[i++].t;
      node = { type: 'bin', op, left: node, right: unary(depth) };
    }
    return node;
  };
  const unary = (depth) => {
    if (peek()?.t === '-') {
      i++;
      if (depth + 1 > MAX_DEPTH) throw fail(posOf(), `nested too deeply (at most ${MAX_DEPTH} levels)`);
      return { type: 'neg', arg: unary(depth + 1) };
    }
    return primary(depth);
  };
  const primary = (depth) => {
    const tok = peek();
    if (!tok) throw fail(src.length, 'the formula ends too early');
    if (tok.t === 'num') {
      i++;
      return { type: 'num', value: tok.v };
    }
    if (tok.t === '(') {
      i++;
      const node = expr(depth + 1);
      expect(')');
      return node;
    }
    if (tok.t !== 'id') throw fail(tok.pos, `unexpected "${tok.t}"`);
    i++;
    if (peek()?.t !== '(') {
      if (peek()?.t === '.')
        throw fail(
          tok.pos,
          `${tok.v}.${tokens[i + 1]?.v ?? '…'} works only inside sum, avg, min, max, first or last`,
        );
      return { type: 'key', name: tok.v };
    }
    const fn = tok.v.toLowerCase();
    if (!FUNCS.has(fn)) throw fail(tok.pos, `unknown function "${tok.v}" (use ${[...FUNCS].join(', ')})`);
    i++;
    const args = [];
    do {
      if (args.length) i++;
      args.push(arg(fn, depth + 1));
    } while (peek()?.t === ',');
    expect(')');
    if (fn === 'count' && (args.length !== 1 || args[0].type !== 'key'))
      throw fail(tok.pos, 'count takes one source key, e.g. count(workorders)');
    if (fn === 'round' && args.length > 2) throw fail(tok.pos, 'round takes a value and the decimals');
    if (fn === 'abs' && args.length !== 1) throw fail(tok.pos, 'abs takes one value');
    return { type: 'call', fn, args };
  };
  const arg = (fn, depth) => {
    if (depth > MAX_DEPTH) throw fail(posOf(), `nested too deeply (at most ${MAX_DEPTH} levels)`);
    const [a, dot, b] = [tokens[i], tokens[i + 1], tokens[i + 2]];
    if (a?.t === 'id' && dot?.t === '.') {
      if (!COLUMN_FUNCS.has(fn)) throw fail(a.pos, `${fn} can't take a column`);
      if (b?.t !== 'id') throw fail(dot.pos, 'expected a field name after "."');
      i += 3;
      return { type: 'field', key: a.v, field: b.v };
    }
    return expr(depth);
  };

  const ast = expr(0);
  if (i < tokens.length) throw fail(tokens[i].pos, `unexpected "${tokens[i].v ?? tokens[i].t}"`);
  return ast;
};

/** Source keys a formula reads (bare keys and the KEY of KEY.FIELD). */
export const identifiersOf = (ast) => {
  const out = new Set();
  const walk = (n) => {
    if (n.type === 'key') out.add(n.name);
    else if (n.type === 'field') out.add(n.key);
    else if (n.type === 'bin') {
      walk(n.left);
      walk(n.right);
    } else if (n.type === 'neg') walk(n.arg);
    else if (n.type === 'call') n.args.forEach(walk);
  };
  walk(ast);
  return [...out];
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOf = (v) => {
  if (isNum(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Evaluates an AST against `scope` ({ key: number | rows[] }); missing numbers and x/0 give null. */
export const evalExpr = (ast, scope = {}) => {
  const has = (k) => Object.hasOwn(scope, k);
  const values = (n) => {
    if (n.type === 'field') {
      const rows = has(n.key) ? scope[n.key] : null;
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => numOf(r?.[n.field])).filter((v) => v != null);
    }
    const v = ev(n);
    return v == null ? [null] : [v];
  };
  const ev = (n) => {
    switch (n.type) {
      case 'num':
        return n.value;
      case 'key': {
        const v = has(n.name) ? scope[n.name] : null;
        if (Array.isArray(v))
          throw badRequest(`"${n.name}" is a table; use count(${n.name}) or sum(${n.name}.<field>)`);
        return numOf(v);
      }
      case 'neg': {
        const v = ev(n.arg);
        return v == null ? null : -v;
      }
      case 'bin': {
        const [a, b] = [ev(n.left), ev(n.right)];
        if (a == null || b == null) return null;
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (b === 0) return null;
        return n.op === '/' ? a / b : a % b;
      }
      case 'call':
        return call(n);
      default:
        return null;
    }
  };
  const call = ({ fn, args }) => {
    if (fn === 'count') {
      const v = has(args[0].name) ? scope[args[0].name] : null;
      return Array.isArray(v) ? v.length : null;
    }
    if (fn === 'abs') {
      const v = ev(args[0]);
      return v == null ? null : Math.abs(v);
    }
    if (fn === 'round') {
      const v = ev(args[0]);
      const dp = args[1] ? ev(args[1]) : 0;
      if (v == null || dp == null) return null;
      const f = 10 ** Math.max(0, Math.min(10, Math.trunc(dp)));
      return Math.round(v * f) / f;
    }
    const list = args.flatMap(values);
    if (list.includes(null)) return null;
    if (fn === 'sum') return list.reduce((s, v) => s + v, 0);
    if (!list.length) return null;
    if (fn === 'avg') return list.reduce((s, v) => s + v, 0) / list.length;
    if (fn === 'min') return list.reduce((m, v) => (v < m ? v : m));
    if (fn === 'max') return list.reduce((m, v) => (v > m ? v : m));
    return fn === 'first' ? list[0] : list.at(-1);
  };
  const out = ev(ast);
  return isNum(out) ? out : null;
};

/** Parse + evaluate in one go. */
export const evaluate = (text, scope) => evalExpr(parseExpr(text), scope);
