/**
 * The serial list (`e2e/serialSpecs.ts`) names the spec files that need the stack to themselves,
 * which CI's shards run apart from the rest. A list entry that names no spec file, say after a
 * rename, would move that file into the parallel pass in silence, and an expression that matched
 * another file's path would take a file out of it, so the list must name real files, each once,
 * and the expression must match those files' paths alone.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SERIAL_SPECS, serialSpecs, specPattern } from '../../e2e/serialSpecs';

const e2eDir = join(import.meta.dirname, '..', '..', 'e2e');
const specNames = readdirSync(e2eDir)
  .filter((file) => file.endsWith('.spec.ts'))
  .map((file) => file.slice(0, -'.spec.ts'.length));
const path = (name: string) => join(e2eDir, `${name}.spec.ts`);

describe('the serial list', () => {
  it('names a spec file in e2e/ with every entry', () => {
    expect(SERIAL_SPECS.filter((name) => !specNames.includes(name))).toEqual([]);
  });

  it('names each file once', () => {
    expect(SERIAL_SPECS.filter((name, at) => SERIAL_SPECS.indexOf(name) !== at)).toEqual([]);
  });

  it("matches every entry's path", () => {
    expect(SERIAL_SPECS.filter((name) => !serialSpecs.test(path(name)))).toEqual([]);
  });

  it("matches no other spec file's path", () => {
    const others = specNames.filter((name) => !SERIAL_SPECS.includes(name));
    expect(others.length).toBeGreaterThan(0);
    expect(others.filter((name) => serialSpecs.test(path(name)))).toEqual([]);
  });

  it('matches a whole name, never one that another name begins', () => {
    expect(specPattern(['remember-me']).test(path('remember-me'))).toBe(true);
    expect(specPattern(['remember-me']).test(path('remember-me-on-the-vendor-page'))).toBe(false);
    expect(specPattern(['remember-me-on-the-vendor-page']).test(path('remember-me'))).toBe(false);
    expect(specPattern(['remember-me']).test(join(e2eDir, 'helpers', 'remember-me.spec.ts'))).toBe(
      false,
    );
    expect(specPattern(['remember-me']).test(`${e2eDir}x/remember-me.spec.ts`)).toBe(false);
  });
});
