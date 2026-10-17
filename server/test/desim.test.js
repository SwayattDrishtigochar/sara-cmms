import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOTS = [join(here, '../src'), join(here, '../../client/src')];
const EXT = /\.(js|jsx|css|md)$/;
const FORBIDDEN =
  /simul|isSimulated|simcontrol|simevents|siminstances|simactivity|simstate|accountGenerator|blueprint|\bfake\b|mock data/i;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : EXT.test(entry.name) ? [path] : [];
  });

/** SARA reads like a real platform: no source file mentions a simulation or fake data (demo mode is a real feature). */
describe('de-sim', () => {
  it('leaves no trace of a simulator in server/src or client/src', () => {
    const hits = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const m = FORBIDDEN.exec(line);
            if (m) hits.push(`${relative(join(here, '../..'), file)}:${i + 1}: ${m[0]} — ${line.trim()}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });
});
