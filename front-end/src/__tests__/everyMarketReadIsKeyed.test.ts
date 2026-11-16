/**
 * Every market-keyed read goes through `useServerRead`; nothing reads on a watch of a market id by
 * hand (T421, ADR 0033).
 *
 * Each screen used to hold its own data, loading flag and error, read on `watch(marketId, load)`,
 * and check the answer by hand: nine guards under eight names, or none. Where one was missing, a
 * late answer for the market just left landed under the next one's name (Payments, the drawer,
 * Manage market, the door). `useServerRead` drops an answer for an old key in one place, so the
 * rule is held from the source: a `watch(` whose source names a market id stands only in a file
 * listed below, no more times than listed, each with why it is not a read by hand.
 *
 * A listed file with fewer such watches than listed passes, so a task that removes one fails
 * nothing; a new one, in any file, fails here by name.
 *
 * What it does NOT see, so that the next reader does not assume otherwise:
 *
 * - A watch whose source is another ref that follows the market (a keyed read's `key`, a computed
 *   over the route): a reset on `read.key` is how a screen forgets what it showed, and is no read.
 * - A read in a watch's callback when its source names no market id, or `watch` imported under
 *   another name.
 * - A market id under another name (`planMarket?.id`): the forms matched are `marketId` (bare,
 *   `props.`, `route.params.`, `.value`) and `market.id` (`?.`, `!.`, `.value`, `props.`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import ts from 'typescript';
import { parse } from 'vue/compiler-sfc';

// Resolved from the project root rather than `import.meta.url`, for the reason
// `contrast.test.ts` gives.
const SRC = resolvePath(process.cwd(), 'src');
const NOT_THE_APP = [join(SRC, '__tests__'), join(SRC, 'dev')];

/**
 * Each file that may watch a market id, the most times it may, and why none of them reads the
 * server by hand. Re-checked against the code on the branch, 2026-11-17.
 */
const MAY_WATCH_A_MARKET_ID: Record<string, { most: number; why: string }> = {
  'utils/openMarket.ts': {
    most: 1,
    why: 'opens the market store, itself one keyed read',
  },
  'components/MarketHistory.vue': {
    most: 1,
    why: 'reads the first page through useHistoryPages, which drops an overtaken page',
  },
  'components/application/ApplicationMonitor.vue': {
    most: 4,
    why:
      "the review's queue, which keeps its own claims and its own guard on an overtaken read " +
      '(out of T421), and three closings of what was open on the last market: the highlights ' +
      'dialog, the reviewed card, the follow-up',
  },
  'components/market/ReviewersPanel.vue': {
    most: 1,
    why: 'resumes a save left unanswered on this market, a write and not a read',
  },
  'components/market/MarketDiscordCard.vue': {
    most: 1,
    why: 'puts back the stored invite link over what was typed for the last market',
  },
  'views/CsvImportView.vue': {
    most: 2,
    why: "resets the wizard and the reviewers ticked to the market's own (T277 ticket 13, T419)",
  },
  'views/VendorsView.vue': {
    most: 1,
    why: 'asks again who is signed in, which the keyed read of the vendors then takes as its key',
  },
  'views/PaymentsView.vue': {
    most: 1,
    why: 'asks again who is signed in, which the keyed read of the payments then takes as its key',
  },
};

/** `marketId` in any of its forms, or a market's `id` read through `market`. */
const NAMES_A_MARKET_ID = /\bmarketId\b|\bmarket(?:\.value)?[!?]?\.id\b/;

/** Every source file of the app: under `src`, outside the tests and the dev-only library. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(vue|ts)$/.test(file))
    .map((file) => join(SRC, file))
    .filter((file) => !NOT_THE_APP.some((folder) => file.startsWith(folder + sep)));
}

/** The code of a file: a component's script blocks, or the whole of a TypeScript file. */
function codeOf(file: string, source: string): string {
  if (!file.endsWith('.vue')) return source;
  const { script, scriptSetup } = parse(source, { filename: file }).descriptor;
  return [script?.content, scriptSetup?.content].join('\n');
}

/**
 * The source of each `watch(...)` in some code that names a market id, its whitespace folded.
 * Read from the syntax tree, so a comment or a string that says `watch(marketId` is no watch.
 */
function marketWatchesIn(code: string): string[] {
  const tree = ts.createSourceFile('code.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'watch' &&
      node.arguments.length > 0
    ) {
      const watched = node.arguments[0]!.getText(tree).replace(/\s+/g, ' ');
      if (NAMES_A_MARKET_ID.test(watched)) found.push(watched);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Each app file with a watch of a market id, and what each watches. */
function everyMarketWatch(): Map<string, string[]> {
  const watches = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const found = marketWatchesIn(codeOf(file, readFileSync(file, 'utf8')));
    if (found.length > 0) watches.set(relative(SRC, file).split(sep).join('/'), found);
  }
  return watches;
}

describe('the guard itself', () => {
  it.each([
    ['a bare id', 'watch(marketId, load);'],
    ['a getter of a prop', 'watch(() => props.marketId, load, { immediate: true });'],
    ['the route', 'watch(() => route.params.marketId, load);'],
    ['a ref read in a getter', 'watch(() => marketId.value, load);'],
    ['an id read through the market', 'watch(() => market.value?.id, load);'],
    ['a prop market', 'watch(() => props.market.id, load);'],
    ['a market sure to be there', 'watch(() => market!.id, load);'],
    ['one source of several', 'watch([() => props.visible, () => props.market?.id], load);'],
    ['an array key', 'watch([marketId, email], load);'],
    ['a source over several lines', 'watch(\n  () =>\n    marketId.value,\n  load,\n);'],
    ['a watch inside a function', 'function setUp() { watch(marketId, () => void load()); }'],
  ])('fires on %s', (_name, code) => {
    expect(marketWatchesIn(code)).toHaveLength(1);
  });

  it.each([
    ['a keyed read', 'const read = useServerRead(() => marketId.value || null, fetcher, o);'],
    ["a reset on a keyed read's key", 'watch(read.key, forgetFolds);'],
    ['a watch of something else', 'watch(open, () => (shown.value = marketId.value));'],
    ['the words in a comment', '// watch(marketId, load)\n/* watch(() => market?.id, load) */'],
    ['the words in a string', "const said = 'watch(marketId, load)';"],
    ['a method of the same name', 'store.watch(marketId, load);'],
    ['a name that only ends in market', 'watch(() => planMarket?.id, load);'],
    ['a market id under another word', 'watch(() => marketIds.value, load);'],
  ])('is quiet on %s', (_name, code) => {
    expect(marketWatchesIn(code)).toEqual([]);
  });

  it('reads the source it claims to, the market store opener among it', () => {
    const files = sourceFiles().map((file) => relative(SRC, file).split(sep).join('/'));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('utils/useServerRead.ts');
    expect(everyMarketWatch().get('utils/openMarket.ts')).toEqual(['marketId']);
  });
});

describe('every market-keyed read is keyed', () => {
  it('has no watch of a market id outside the files listed, nor more than each is allowed', () => {
    const over = [...everyMarketWatch()]
      .filter(([file, found]) => found.length > (MAY_WATCH_A_MARKET_ID[file]?.most ?? 0))
      .map(([file, found]) => `${file}: ${found.join(' | ')}`);

    expect(
      over,
      'a market-keyed read goes through useServerRead, never a watch of a market id ' +
        '(docs/implementation/conventions/one-market-from-the-server.md); a watch that is no read ' +
        'is listed in MAY_WATCH_A_MARKET_ID with why',
    ).toEqual([]);
  });
});
