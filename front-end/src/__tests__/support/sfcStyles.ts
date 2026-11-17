/**
 * A component's look, read from the stylesheet that ships: happy-dom applies no style, so a mounted
 * component asserts nothing of a border or a breakpoint, and its rules are read as `primitives.test.ts`
 * reads its own.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import postcss from 'postcss';
import { parse as parseSfc } from 'vue/compiler-sfc';

/** The styles of a component under `src/components`, parsed. */
export function stylesOf(file: string): postcss.Root {
  const { descriptor } = parseSfc(
    readFileSync(resolvePath(process.cwd(), 'src/components', file), 'utf8'),
  );
  return postcss.parse(descriptor.styles.map((style) => style.content).join('\n'));
}

/** The media query a rule stands in, or `''` outside any. */
export const queryOf = (rule: postcss.Rule): string =>
  rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : '';

/** What `property` is given for `selector`, in rules under `query` (`''` for none), the last winning. */
export function valueOf(
  root: postcss.Root,
  selector: string,
  property: string,
  query = '',
): string | null {
  let value: string | null = null;
  root.walkRules((rule) => {
    if (!rule.selectors.includes(selector) || queryOf(rule) !== query) return;
    rule.walkDecls(property, (decl) => {
      value = decl.value;
    });
  });
  return value;
}
