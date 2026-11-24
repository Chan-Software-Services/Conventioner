// @vitest-environment node
/**
 * The design contract (T582): `DESIGN.md` is generated from `base.css` and `primitives.css` in
 * Google's DESIGN.md format, so it never drifts from the CSS, and the pinned `@google/design.md`
 * linter reads it as the format means.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lint } from '@google/design.md/linter';

import { CONTENT, type Content } from '../../scripts/design-md-content';
import { readSources, render, Refusal, writeDesignMd, type Sources } from '../../scripts/design-md';

/** Words naming nothing, so a fixture's few tokens pass the hand-kept guard. */
const PLAIN: Content = {
  ...CONTENT,
  overview: ['The overview.'],
  colors: ['The colours.'],
  typography: ['The type.'],
  layout: ['The layout.'],
  elevation: ['The elevation.'],
  shapes: ['The shapes.'],
  components: ['The components.'],
  dosAndDonts: ['- Do one thing.'],
};

const MAIN = `@layer global {
  @font-face {
    font-family: 'Merge One';
    src: url('/fonts/MergeOne-Regular.woff2') format('woff2');
  }
  @font-face {
    font-family: 'Outfit';
    src: url('/fonts/Outfit-VariableFont_wght.woff2') format('woff2');
  }
}
`;

const PRIMITIVES = `.btn {
  height: var(--control-height);
}
`;

const BASE = `/* The palette. */
:root {
  /* Ink. A comment on lines of its own is history,
     and is left out. */
  --mm-black: #272323; /* 15.54 on white,
     12.49 on beige */
  --mm-text-muted: rgba(39, 35, 35, 0.63);
  --mm-green: #36826f; /* white text on it: 4.59 */
  --focus-border: var(--mm-green);

  --text-xs: 12px; /* captions */
  --text-sm: 14px;
  --leading: 1.6;

  --space-1: 4px;
  --space-3: 12px;
  --edge-shade-depth: var(--space-3);
  --control-height: 36px;
  --target-min: 24px;

  --radius-control: 6px; /* buttons, inputs */

  --shadow-card:
    0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.07);
  --focus-halo: 0 0 0 2px white, 0 0 0 5px rgba(54, 130, 111, 0.35);
}

@media (width <= 640px) {
  :root {
    --control-height: 44px;
    --target-min: 44px;
  }
}

:root {
  --color-text: #2c3e50; /* 10.35 on white */
}

body {
  font-family:
    Outfit,
    -apple-system,
    sans-serif;
}
`;

const FIXTURE: Sources = { base: BASE, primitives: PRIMITIVES, main: MAIN };

function frontMatter(text: string): string {
  return text.slice(0, text.indexOf('\n---\n', 4) + 5);
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof Refusal) return error.message;
    throw error;
  }
  throw new Error('it did not refuse');
}

describe('the tokens, on fixture CSS', () => {
  const { text } = render(FIXTURE, PLAIN);
  const yaml = frontMatter(text);

  it('puts a hex, an rgba() and a var() colour in colors, the last as a reference', () => {
    expect(yaml).toContain(
      'colors:\n' +
        '  primary: "{colors.mm-green}" # the format\'s name for --mm-green; the CSS has no --primary\n' +
        '  mm-black: "#272323" # 15.54 on white, 12.49 on beige\n' +
        '  mm-text-muted: "rgba(39, 35, 35, 0.63)"\n' +
        '  mm-green: "#36826f" # white text on it: 4.59\n' +
        '  focus-border: "{colors.mm-green}"\n' +
        '  color-text: "#2c3e50" # 10.35 on white\n' +
        'typography:\n',
    );
  });

  it('puts a --radius-* in rounded, a px token in spacing, and a var() of one as a reference', () => {
    expect(yaml).toContain('rounded:\n  radius-control: "6px" # buttons, inputs\nspacing:\n');
    expect(yaml).toContain(
      'spacing:\n' +
        '  space-1: "4px"\n' +
        '  space-3: "12px"\n' +
        '  edge-shade-depth: "{spacing.space-3}"\n' +
        '  control-height: "36px"\n' +
        '  target-min: "24px"\n' +
        '---\n',
    );
  });

  it('keeps the shadows and the halos out of the YAML, in the Elevation and the no-group tables', () => {
    expect(yaml).not.toContain('shadow-card');
    expect(yaml).not.toContain('focus-halo');
    const elevation = text.slice(text.indexOf('## Elevation & Depth'), text.indexOf('## Shapes'));
    expect(elevation).toContain(
      '| Token | Value |\n| --- | --- |\n' +
        '| `--shadow-card` | `0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.07)` |\n',
    );
    expect(elevation).not.toContain('focus-halo');
    const components = text.slice(
      text.indexOf('## Components'),
      text.indexOf("## Do's and Don'ts"),
    );
    expect(components).toContain(
      '### Tokens the format has no group for\n\n| Token | Value |\n| --- | --- |\n' +
        '| `--focus-halo` | `0 0 0 2px white, 0 0 0 5px rgba(54, 130, 111, 0.35)` |\n',
    );
    expect(components).not.toContain('shadow-card');
  });

  it('writes a same-line comment as the YAML comment, and leaves out a comment on lines above', () => {
    expect(yaml).toContain('# 15.54 on white, 12.49 on beige\n');
    expect(text).not.toContain('history');
    expect(text).not.toContain('The palette.');
  });

  it("makes a phone override the Layout table's row, with both values", () => {
    const layout = text.slice(text.indexOf('## Layout'), text.indexOf('## Elevation & Depth'));
    expect(layout).toContain(
      'At `(width <= 640px)`:\n\n| Token | Otherwise | Here |\n| --- | --- | --- |\n' +
        '| `--control-height` | `36px` | `44px` |\n' +
        '| `--target-min` | `24px` | `44px` |\n',
    );
  });

  it('makes three levels of each --text-* step, with --leading as their line height', () => {
    expect(yaml).toContain(
      'typography:\n' +
        '  text-xs:\n    fontFamily: "Outfit"\n    fontSize: "12px" # captions\n' +
        '    fontWeight: 400\n    lineHeight: 1.6\n' +
        '  text-xs-strong:\n    fontFamily: "Outfit"\n    fontSize: "12px" # captions\n' +
        '    fontWeight: 600\n    lineHeight: 1.6\n' +
        '  heading-xs:\n    fontFamily: "Merge One"\n    fontSize: "12px" # captions\n' +
        '    fontWeight: 400\n    lineHeight: 1.6\n' +
        '  text-sm:\n    fontFamily: "Outfit"\n    fontSize: "14px"\n' +
        '    fontWeight: 400\n    lineHeight: 1.6\n' +
        '  text-sm-strong:\n    fontFamily: "Outfit"\n    fontSize: "14px"\n' +
        '    fontWeight: 600\n    lineHeight: 1.6\n' +
        '  heading-sm:\n    fontFamily: "Merge One"\n    fontSize: "14px"\n' +
        '    fontWeight: 400\n    lineHeight: 1.6\n' +
        'rounded:\n',
    );
  });

  it('starts with the format keys in order, and the body with its generated-file line', () => {
    expect(text.startsWith('---\nversion: alpha\nname: Conventioner\ndescription: "')).toBe(true);
    expect(text.slice(yaml.length)).toMatch(
      /^<!-- Generated by front-end\/scripts\/design-md\.ts .* -->\n\n# Conventioner's design contract\n\n## Overview\n/,
    );
  });

  it('renders the same text twice, ending in one newline', () => {
    expect(render(FIXTURE, PLAIN).text).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('counts what it wrote', () => {
    expect(render(FIXTURE, PLAIN).counts).toEqual({
      colors: 6,
      typography: 6,
      rounded: 1,
      spacing: 5,
      components: 0,
    });
  });
});

describe('the guards', () => {
  it('refuses a token declared twice in the top-level :root rules', () => {
    const base = BASE + ':root {\n  --space-1: 8px;\n}\n';
    expect(refusal(() => render({ ...FIXTURE, base }, PLAIN))).toBe(
      '--space-1 is declared twice in base.css',
    );
  });

  it('refuses a body family that main.css loads no face of', () => {
    const main = MAIN.replace("'Outfit'", "'Inter'");
    expect(refusal(() => render({ ...FIXTURE, main }, PLAIN))).toBe(
      'Outfit is not a face main.css loads',
    );
  });

  it('refuses a heading family that main.css loads no face of', () => {
    expect(refusal(() => render(FIXTURE, { ...PLAIN, headingFamily: 'Merge Two' }))).toBe(
      'Merge Two is not a face main.css loads',
    );
  });

  it('refuses words naming a token base.css does not have, alone or in a var()', () => {
    expect(refusal(() => render(FIXTURE, { ...PLAIN, colors: ['Ink is `--mm-pink`.'] }))).toBe(
      'the words of Colors name --mm-pink, which base.css does not have',
    );
    expect(
      refusal(() => render(FIXTURE, { ...PLAIN, dosAndDonts: ['- Do write `var(--space-5)`.'] })),
    ).toBe("the words of Do's and Don'ts name --space-5, which base.css does not have");
  });

  it('refuses words naming a class primitives.css does not have', () => {
    expect(
      refusal(() => render(FIXTURE, { ...PLAIN, layout: ['A grid is `.btn.card-grid`.'] })),
    ).toBe('the words of Layout name .card-grid, which primitives.css does not have');
  });

  it('leaves a span that is neither a token nor classes unchecked', () => {
    const words = ['The `--mm-text-*` inks, `contrast.test.ts`, `.btn` and `var(--space-1)`.'];
    expect(() => render(FIXTURE, { ...PLAIN, colors: words })).not.toThrow();
  });

  describe('writing', () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true });
      dir = undefined;
    });

    function frontEnd(sources: Sources): string {
      dir = mkdtempSync(join(tmpdir(), 'design-md-'));
      mkdirSync(join(dir, 'src/assets'), { recursive: true });
      writeFileSync(join(dir, 'src/assets/base.css'), sources.base);
      writeFileSync(join(dir, 'src/assets/primitives.css'), sources.primitives);
      writeFileSync(join(dir, 'src/assets/main.css'), sources.main);
      return dir;
    }

    it('writes the rendered file and says what it holds', () => {
      const root = frontEnd(FIXTURE);
      const target = join(root, 'DESIGN.md');
      expect(writeDesignMd(root, target, PLAIN)).toBe(
        'Wrote DESIGN.md: 6 colours, 6 typography levels, 1 rounded, 5 spacing, 0 components.',
      );
      expect(readFileSync(target, 'utf8')).toBe(render(FIXTURE, PLAIN).text);
    });

    it('writes nothing when a guard refuses', () => {
      const root = frontEnd({ ...FIXTURE, base: BASE + ':root {\n  --space-1: 8px;\n}\n' });
      const target = join(root, 'DESIGN.md');
      writeFileSync(target, 'the old file\n');
      expect(refusal(() => writeDesignMd(root, target, PLAIN))).toBe(
        '--space-1 is declared twice in base.css',
      );
      expect(readFileSync(target, 'utf8')).toBe('the old file\n');
    });
  });
});

describe('the real files', () => {
  const sources = readSources(process.cwd());
  const { text } = render(sources);
  const report = lint(text);

  /** Every custom property a top-level `:root` rule of base.css declares, with its value. */
  function tokens(): Map<string, string> {
    const found = new Map<string, string>();
    for (const [, body] of sources.base.matchAll(/^:root \{\n([\s\S]*?)^\}/gm)) {
      const stripped = body!.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, name, value] of stripped.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
        found.set(name!, value!.replace(/\s+/g, ' ').trim());
      }
    }
    return found;
  }

  /** The `#rrggbb` (or `#rrggbbaa`) a CSS colour means, alpha rounded to the nearest 1/255. */
  function hexOf(value: string, all: Map<string, string>): string {
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (ref) return hexOf(all.get(ref[1]!)!, all);
    if (value === 'white') return '#ffffff';
    const rgba = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
    if (rgba) {
      const [, r, g, b, a] = rgba;
      const hex = [r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
      const alpha =
        a === undefined
          ? ''
          : Math.round(Number(a) * 255)
              .toString(16)
              .padStart(2, '0');
      return `#${hex}${alpha === 'ff' ? '' : alpha}`;
    }
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
    if (short)
      return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
    return value.toLowerCase();
  }

  it('names every custom property of base.css, as a YAML key or a table row', () => {
    const missing = [...tokens().keys()].filter(
      (name) =>
        !new RegExp(`^  ${name.slice(2)}:`, 'm').test(text) && !text.includes(`| \`${name}\` |`),
    );
    // `--leading` is every level's lineHeight rather than a key, and the Typography words name it.
    expect(missing).toEqual(['--leading']);
    expect(text).toContain(`lineHeight: ${tokens().get('--leading')}\n`);
    expect(text).toContain("Running text's line height is `--leading`");
  });

  it("is read by the format's own parser with the colour each CSS value means", () => {
    const all = tokens();
    const colours = report.designSystem.colors;
    const read = Object.fromEntries([...colours].map(([name, colour]) => [name, colour.hex]));
    const meant = Object.fromEntries(
      [...colours.keys()].map((name) => [
        name,
        hexOf(name === 'primary' ? 'var(--mm-green)' : all.get(`--${name}`)!, all),
      ]),
    );
    expect(read).toEqual(meant);
    expect(colours.size).toBeGreaterThan(70);
  });

  it('lints with no error and no warning', () => {
    expect(report.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
  });
});
