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
import postcss from 'postcss';

import { CONTENT, type Content } from '../../scripts/design-md-content';
import {
  checkDesignMd,
  drift,
  lintPolicy,
  readSources,
  render,
  Refusal,
  writeDesignMd,
  type Sources,
} from '../../scripts/design-md';

/**
 * Words naming nothing, so a fixture's few tokens pass the hand-kept guard, and one component for the
 * fixture's one primitive, so the completeness guard passes too.
 */
const PLAIN: Content = {
  ...CONTENT,
  overview: ['The overview.'],
  colors: ['The colours.'],
  typography: ['The type.'],
  layout: ['The layout.'],
  elevation: ['The elevation.'],
  shapes: ['The shapes.'],
  components: ['The components.'],
  componentGroups: [{ name: 'Buttons', words: ['The buttons.'] }],
  componentEntries: [{ key: 'btn', group: 'Buttons', selectors: ['.btn'] }],
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
        'components:\n',
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
      components: 1,
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
        'Wrote DESIGN.md: 6 colours, 6 typography levels, 1 rounded, 5 spacing, 1 components.',
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

/** The primitives of the components' fixture: a button, its intent, a state of it, a title. */
const COMPONENT_PRIMITIVES = `.btn {
  display: inline-flex;
  height: var(--control-height);
  padding: 0 var(--space-3);
  border-radius: var(--radius-control);
  font-size: var(--text-sm);
  font-weight: 400;
  cursor: pointer;
}

.btn--primary {
  --focus-border: var(--focus-border);
  background: var(--mm-green);
  color: white;
  font-weight: 600;
}

.btn--primary:hover:not(:disabled),
.btn--quiet:hover {
  background: var(--color-text);
}

.btn--quiet {
  background: none;
}

.title {
  font-family: 'Merge One', serif;
  font-size: var(--text-xs);
  width: 100%;
}

@media print {
  .title {
    color: black;
  }
}
`;

const COMPONENTS: Content = {
  ...PLAIN,
  componentGroups: [
    { name: 'Buttons', words: ['The buttons.'] },
    { name: 'Titles', words: ['The titles.'] },
  ],
  componentEntries: [
    { key: 'btn', group: 'Buttons', selectors: ['.btn'] },
    { key: 'btn-primary', group: 'Buttons', selectors: ['.btn', '.btn--primary'] },
    {
      key: 'btn-primary-hover',
      group: 'Buttons',
      selectors: ['.btn', '.btn--primary', '.btn--primary:hover:not(:disabled)'],
    },
    { key: 'btn-quiet', group: 'Buttons', selectors: ['.btn', '.btn--quiet'] },
    { key: 'title', group: 'Titles', selectors: ['.title'] },
  ],
};

const COMPONENT_FIXTURE: Sources = { ...FIXTURE, primitives: COMPONENT_PRIMITIVES };

describe('the components, on fixture CSS', () => {
  const { text, counts } = render(COMPONENT_FIXTURE, COMPONENTS);
  const yaml = frontMatter(text);
  const components = text.slice(text.indexOf('## Components'), text.indexOf("## Do's and Don'ts"));

  it("gives a state its own fill and its base's ink, the type and the box", () => {
    expect(yaml).toContain(
      '  btn-primary-hover:\n' +
        '    backgroundColor: "{colors.color-text}"\n' +
        '    textColor: "white"\n' +
        '    typography: "{typography.text-sm-strong}"\n' +
        '    rounded: "{rounded.radius-control}"\n' +
        '    padding: "0 var(--space-3)"\n' +
        '    height: "{spacing.control-height}"\n',
    );
  });

  it('references the -strong level at weight 600, the heading level in Merge One, else the plain one', () => {
    expect(yaml).toContain('  btn:\n    typography: "{typography.text-sm}"\n');
    expect(yaml).toContain('  btn-primary:\n    backgroundColor: "{colors.mm-green}"\n');
    expect(yaml).toMatch(
      / {2}btn-primary:\n(?: {4}.*\n)*? {4}typography: "\{typography\.text-sm-strong\}"\n/,
    );
    expect(yaml).toContain(
      '  title:\n    typography: "{typography.heading-xs}"\n    width: "100%"\n---\n',
    );
  });

  it('takes the fill away on `background: none`, and leaves @media rules out', () => {
    expect(yaml).toContain('  btn-quiet:\n    typography: "{typography.text-sm}"\n');
    expect(yaml).not.toMatch(/ {2}btn-quiet:\n(?: {4}.*\n)*? {4}backgroundColor/);
    expect(yaml).not.toContain('"black"');
  });

  it("lists the last selector's declarations no sub-token carries, under its group", () => {
    expect(components).toContain(
      '### Buttons\n\nThe buttons.\n\n' +
        '- **`btn`** (`.btn`): `display: inline-flex`, `cursor: pointer`.\n' +
        '- **`btn-primary`** (`.btn`, `.btn--primary`): `--focus-border: var(--focus-border)`.\n' +
        '- **`btn-primary-hover`** (`.btn`, `.btn--primary`, `.btn--primary:hover:not(:disabled)`).\n' +
        '- **`btn-quiet`** (`.btn`, `.btn--quiet`): `background: none`.\n' +
        '\n### Titles\n\nThe titles.\n\n' +
        // Merge One is carried by the heading level the entry references.
        '- **`title`** (`.title`).\n' +
        '\n### Tokens the format has no group for\n',
    );
  });

  it('writes an entry with no sub-token as an empty map', () => {
    const quiet: Content = {
      ...COMPONENTS,
      componentEntries: [
        ...COMPONENTS.componentEntries,
        { key: 'btn-quiet-hover', group: 'Buttons', selectors: ['.btn--quiet:hover'] },
      ],
    };
    expect(render(COMPONENT_FIXTURE, quiet).text).toContain(
      '  btn-quiet-hover:\n    backgroundColor: "{colors.color-text}"\n',
    );
    const bare = `${COMPONENT_PRIMITIVES}\n.bare {\n  display: grid;\n}\n`;
    const withBare: Content = {
      ...COMPONENTS,
      componentEntries: [
        ...COMPONENTS.componentEntries,
        { key: 'bare', group: 'Titles', selectors: ['.bare'] },
      ],
    };
    expect(
      frontMatter(render({ ...COMPONENT_FIXTURE, primitives: bare }, withBare).text),
    ).toContain('  bare: {}\n---\n');
  });

  it('counts the components', () => {
    expect(counts.components).toBe(5);
  });

  it('guards the words of each group as it guards a section', () => {
    const words: Content = {
      ...COMPONENTS,
      componentGroups: [
        { name: 'Buttons', words: ['`.btn--ghost`.'] },
        COMPONENTS.componentGroups[1]!,
      ],
    };
    expect(refusal(() => render(COMPONENT_FIXTURE, words))).toBe(
      'the words of Components name .btn--ghost, which primitives.css does not have',
    );
  });

  it('refuses an entry of a group that has no words', () => {
    const lost: Content = { ...COMPONENTS, componentGroups: [COMPONENTS.componentGroups[0]!] };
    expect(refusal(() => render(COMPONENT_FIXTURE, lost))).toBe(
      "title's group Titles has no words in scripts/design-md-content.ts",
    );
  });

  describe('its refusals write nothing', () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true });
      dir = undefined;
    });

    const cases: [string, Sources, Content, string][] = [
      [
        'an unknown selector',
        COMPONENT_FIXTURE,
        {
          ...COMPONENTS,
          componentEntries: [
            ...COMPONENTS.componentEntries,
            { key: 'btn-ghost', group: 'Buttons', selectors: ['.btn', '.btn--ghost'] },
          ],
        },
        '.btn--ghost (component btn-ghost in scripts/design-md-content.ts) is in no rule of primitives.css',
      ],
      [
        'an unnamed class',
        COMPONENT_FIXTURE,
        {
          ...COMPONENTS,
          componentEntries: COMPONENTS.componentEntries.filter(({ key }) => key !== 'btn-quiet'),
        },
        "primitives.css has .btn--quiet, which DESIGN.md never names: give it a component in scripts/design-md-content.ts, or name it in that file's prose",
      ],
      [
        'a raw font size',
        {
          ...COMPONENT_FIXTURE,
          primitives: COMPONENT_PRIMITIVES.replace('var(--text-xs)', '13px'),
        },
        COMPONENTS,
        "title's font-size is not a --text-* token",
      ],
      [
        'a font size of a token off the type scale',
        {
          ...COMPONENT_FIXTURE,
          primitives: COMPONENT_PRIMITIVES.replace('var(--text-xs)', 'var(--space-3)'),
        },
        COMPONENTS,
        "title's font-size is not a --text-* token",
      ],
    ];

    it.each(cases)('refuses %s', (_, sources, content, message) => {
      dir = mkdtempSync(join(tmpdir(), 'design-md-'));
      mkdirSync(join(dir, 'src/assets'), { recursive: true });
      writeFileSync(join(dir, 'src/assets/base.css'), sources.base);
      writeFileSync(join(dir, 'src/assets/primitives.css'), sources.primitives);
      writeFileSync(join(dir, 'src/assets/main.css'), sources.main);
      const target = join(dir, 'DESIGN.md');
      writeFileSync(target, 'the old file\n');
      expect(refusal(() => writeDesignMd(dir!, target, content))).toBe(message);
      expect(readFileSync(target, 'utf8')).toBe('the old file\n');
    });
  });

  it('names a class through the prose as well as through a selector', () => {
    const named: Content = {
      ...COMPONENTS,
      componentGroups: [
        { name: 'Buttons', words: ['A quiet button is `.btn--quiet`.'] },
        COMPONENTS.componentGroups[1]!,
      ],
      componentEntries: COMPONENTS.componentEntries.filter(({ key }) => key !== 'btn-quiet'),
    };
    expect(() => render(COMPONENT_FIXTURE, named)).not.toThrow();
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

  it('names every class primitives.css names, as a selector or in the words', () => {
    const classes = new Set<string>();
    postcss.parse(sources.primitives).walkRules((rule) => {
      for (const [, name] of rule.selector.matchAll(/\.([a-zA-Z_][\w-]*)/g)) classes.add(name!);
    });
    const named = new Set([...text.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(([, name]) => name!));
    expect(classes.size).toBeGreaterThan(25);
    expect([...classes].filter((name) => !named.has(name))).toEqual([]);
  });

  it('writes every component of the content, in its order', () => {
    const keys = [...frontMatter(text).matchAll(/^ {2}([a-z0-9-]+):(?: \{\})?$/gm)]
      .map(([, key]) => key!)
      .filter((key) => !/^(?:text|heading)-/.test(key));
    expect(keys).toEqual(CONTENT.componentEntries.map(({ key }) => key));
  });

  it('lints with no error, and no warning but orphaned-tokens', () => {
    const findings = report.findings.filter(
      (finding) => finding.severity !== 'info' && finding.rule !== 'orphaned-tokens',
    );
    expect(findings).toEqual([]);
    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  });

  it('allows as orphans exactly the colours no component uses', () => {
    const yaml = frontMatter(text);
    const colours = yaml.slice(yaml.indexOf('\ncolors:\n'), yaml.indexOf('\ntypography:\n'));
    const aliases = new Map<string, string | undefined>(
      [...colours.matchAll(/^ {2}([a-z0-9-]+): "(.*?)"/gm)].map(([, name, value]) => [
        name!,
        /^\{colors\.([a-z0-9-]+)\}$/.exec(value!)?.[1],
      ]),
    );
    const block = yaml.slice(yaml.indexOf('\ncomponents:\n'));
    const used = new Set(
      [...block.matchAll(/"\{colors\.([a-z0-9-]+)\}"/g)].map(([, name]) => name!),
    );
    // A colour is used when a component references it, when it names a used colour, or when a used
    // colour names it: the linter resolves an alias to the colour it names.
    for (let grown = true; grown;) {
      grown = false;
      for (const [name, target] of aliases) {
        if (!target) continue;
        for (const [from, to] of [
          [name, target],
          [target, name],
        ] as const) {
          if (used.has(from) && !used.has(to)) {
            used.add(to);
            grown = true;
          }
        }
      }
    }
    const unused = [...aliases.keys()].filter((name) => !used.has(name)).sort();
    const allowed = report.findings
      .filter((finding) => finding.rule === 'orphaned-tokens')
      .map((finding) => finding.path!.replace(/^colors\./, ''))
      .sort();
    expect(allowed).toEqual(unused);
    expect(allowed.length).toBeGreaterThan(0);
    expect(
      report.findings.every((f) => f.rule !== 'orphaned-tokens' || f.severity === 'warning'),
    ).toBe(true);
  });
});

describe('the check', () => {
  const sources = readSources(process.cwd());
  const generated = render(sources).text;
  const STALE =
    'DESIGN.md is not what front-end/scripts/design-md.ts writes from base.css and ' +
    'primitives.css: run `npm run design-md` in front-end/ and commit it.';

  /** The line of `text` (1-based) that holds `needle`. */
  const lineOf = (text: string, needle: string) =>
    text.split('\n').findIndex((line) => line.includes(needle)) + 1;

  it('finds no drift in what the generator writes', () => {
    expect(drift(generated, generated)).toEqual([]);
  });

  it('reports a hand edit as drift, at its line', () => {
    const edited = generated.replace('The look is quiet', 'The look is loud');
    const line = lineOf(generated, 'The look is quiet');
    expect(drift(edited, generated)).toEqual([
      STALE,
      `First difference at line ${line}:`,
      `committed: ${edited.split('\n')[line - 1]}`,
      `generated: ${generated.split('\n')[line - 1]}`,
    ]);
  });

  it('reports a changed token as drift, at its line', () => {
    const moved = render({
      ...sources,
      base: sources.base.replace('--space-1: 4px;', '--space-1: 5px;'),
    }).text;
    const line = lineOf(generated, '  space-1: "4px"');
    expect(line).toBeGreaterThan(0);
    expect(drift(generated, moved)).toEqual([
      STALE,
      `First difference at line ${line}:`,
      'committed:   space-1: "4px"',
      'generated:   space-1: "5px"',
    ]);
  });

  it('reports a missing file as drift', () => {
    expect(drift(undefined, generated)).toEqual([
      STALE,
      'First difference at line 1:',
      'committed: (no DESIGN.md)',
      `generated: ${generated.split('\n')[0]}`,
    ]);
  });

  it('reports an extra or a missing last newline as drift, at its line', () => {
    const last = generated.split('\n').length - 1;
    expect(drift(generated + '\n', generated).slice(1)).toEqual([
      `First difference at line ${last + 1}:`,
      'committed: ',
      'generated: (end of file)',
    ]);
    const end = generated.split('\n')[last - 1];
    expect(drift(generated.slice(0, -1), generated).slice(1)).toEqual([
      `First difference at line ${last}:`,
      `committed: ${end} (no newline at the end of the file)`,
      `generated: ${end}`,
    ]);
  });

  describe('the lint policy', () => {
    const orphan = (name: string) => ({
      severity: 'warning' as const,
      rule: 'orphaned-tokens',
      path: `colors.${name}`,
      message: `'${name}' is defined but never referenced by any component.`,
    });

    it('allows orphaned-tokens warnings and ignores info, and counts them', () => {
      expect(
        lintPolicy([
          orphan('mm-beige'),
          orphan('mm-border'),
          { severity: 'info', rule: 'token-summary', message: 'Design system defines 2 colors.' },
        ]),
      ).toEqual({
        failing: [],
        summary:
          'DESIGN.md lint: 0 errors, 0 warnings; 2 orphaned-tokens warnings allowed ' +
          '(colours no component uses).',
      });
    });

    it('fails an error, a contrast warning and a warning with no rule', () => {
      expect(
        lintPolicy([
          orphan('mm-beige'),
          {
            severity: 'error',
            rule: 'broken-ref',
            path: 'components.btn.textColor',
            message: 'Reference {colors.gone} does not resolve.',
          },
          {
            severity: 'warning',
            rule: 'contrast-ratio',
            path: 'components.btn',
            message: 'textColor on backgroundColor is 2.1:1.',
          },
          { severity: 'warning', message: 'Unexpected key in the front matter.' },
          { severity: 'error', message: 'The YAML does not parse.' },
        ]),
      ).toEqual({
        failing: [
          'error broken-ref components.btn.textColor: Reference {colors.gone} does not resolve.',
          'warning contrast-ratio components.btn: textColor on backgroundColor is 2.1:1.',
          'warning parser -: Unexpected key in the front matter.',
          'error parser -: The YAML does not parse.',
        ],
        summary:
          'DESIGN.md lint: 2 errors, 2 warnings; 1 orphaned-tokens warnings allowed ' +
          '(colours no component uses).',
      });
    });

    it('fails an orphaned-tokens finding raised to an error', () => {
      const raised = { ...orphan('mm-beige'), severity: 'error' as const };
      expect(lintPolicy([raised]).failing).toEqual([
        "error orphaned-tokens colors.mm-beige: 'mm-beige' is defined but never referenced by any component.",
      ]);
    });
  });

  describe('on a file', () => {
    let dir: string | undefined;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true });
      dir = undefined;
    });

    function target(text?: string): string {
      dir = mkdtempSync(join(tmpdir(), 'design-md-check-'));
      const file = join(dir, 'DESIGN.md');
      if (text !== undefined) writeFileSync(file, text);
      return file;
    }

    const summary = (lines: string[]) => lines.filter((line) => line.startsWith('DESIGN.md lint:'));

    it('passes the generated file, saying how many orphans it allowed', () => {
      const { ok, lines } = checkDesignMd(process.cwd(), target(generated));
      expect(ok).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^DESIGN\.md lint: 0 errors, 0 warnings; [1-9]\d* orphaned-tokens warnings allowed \(colours no component uses\)\.$/,
      );
    });

    it('fails a hand edit, and still lints it', () => {
      const edited = generated.replace('The look is quiet', 'The look is loud');
      const { ok, lines } = checkDesignMd(process.cwd(), target(edited));
      expect(ok).toBe(false);
      expect(lines.slice(0, 4)).toEqual(drift(edited, generated));
      expect(summary(lines)).toHaveLength(1);
    });

    it('fails a file that lints unclean, saying each finding', () => {
      const unclean = generated
        .replace('    backgroundColor: "{colors.mm-green}"', '    backgroundColor: "{colors.gone}"')
        .replace(/^ {2}primary: .*\n/m, '');
      const { ok, lines } = checkDesignMd(process.cwd(), target(unclean));
      expect(ok).toBe(false);
      expect(lines.filter((line) => /^(?:error|warning) /.test(line))).toEqual([
        'error broken-ref components.btn-primary: Reference {colors.gone} does not resolve to ' +
          'any defined token.',
        "warning missing-primary colors: No 'primary' color defined. The agent will " +
          'auto-generate key colors, reducing your control over the palette.',
      ]);
      expect(summary(lines)[0]).toMatch(/^DESIGN\.md lint: 1 errors, 1 warnings; [1-9]\d* /);
    });

    it('fails a missing file, with nothing to lint', () => {
      const { ok, lines } = checkDesignMd(process.cwd(), target());
      expect(ok).toBe(false);
      expect(lines[0]).toBe(STALE);
      expect(summary(lines)).toEqual([]);
    });

    it('says why a refused render cannot be generated, and still lints the file', () => {
      const words = { ...CONTENT, shapes: ['Use `--radius-gone`.'] };
      const { ok, lines } = checkDesignMd(process.cwd(), target(generated), words);
      expect(ok).toBe(false);
      expect(lines[0]).toBe(
        'DESIGN.md cannot be generated: the words of Shapes name --radius-gone, which base.css ' +
          'does not have',
      );
      expect(summary(lines)).toHaveLength(1);
    });
  });
});
