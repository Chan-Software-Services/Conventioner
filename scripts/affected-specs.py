#!/usr/bin/env python3
"""The E2E spec files a change reaches, by the test map (T349), run in order up to a cap of CI
minutes; CI's run of a pull request into `dev` is the map's selection, uncapped, or the whole
suite on any doubt, and the merge queue's run is whole.

    python3 scripts/affected-specs.py --run  [options] [-- <playwright arguments>]
    python3 scripts/affected-specs.py --list [options] [--json]
    python3 scripts/affected-specs.py ci [options] --max-shards <n> [--github]
    python3 scripts/affected-specs.py audit [options] [--queue] [--github] <playwright json report>...

From the worktree root, on the worktree's stack (`team-stack up`, `team-stack seed`, and
`eval "$(~/agent-team/bin/team-stack env)"`, so Playwright reaches it). The change is the diff from
the merge-base with `origin/dev` to the worktree, uncommitted and untracked files included
(`--base` and `--head` name two commits instead, for `--list`, `ci` and `audit`). The map is the
newest `test-map` artifact of a run on `dev`, which the nightly Test run makes on `dev`'s tip (or
one started by hand, `gh workflow run test.yml --ref dev`), so up to a day behind `dev`; it is
downloaded once a run to `.stack-logs/test-map/<run id>/` beside that run's shard results (`--map`
and `--results` name files instead). A spec is chosen:

1. when the change edits it, or a file it imports, transitively, or deletes a file it imported at
   the base (scores 1);
2. when its pages loaded a changed file under `front-end/src/` (scores 1 / the specs that did); a
   `.ts` or `.vue` file there that reads the same at both sides with its comments out, by `Words`,
   reaches no spec by any rule;
3. when it called an endpoint whose requests ran a changed back-end function, found by the
   hunk's lines on either side, so a deleted function by its old name (scores 1 / the specs that
   reach it); a line that runs nothing (blank, a comment, a docstring's text) names none, and a
   change outside any function, or in one the map does not know, counts for every function of its
   file, choosing the specs that reach the file and scoring nothing;
4. every spec, when the change edits a file the whole suite stands on, or the E2E run's own
   machinery: the Test workflow, `.github/workflows/test.yml`, a file under `.github/actions/`,
   the shard dealer, `front-end/scripts/e2e-shards.ts`, and its `e2e-shard-timings.json`, this
   script and `scripts/test_map.py`, `scripts/chromium-packages.sh` and `scripts/image-tags.sh`,
   and `.nvmrc`, the Node every shard runs on (`RUN_EVERY_SPEC`);
5. every spec, scoring nothing, when the change edits a file under `front-end/` or `back-end/` no
   rule places: not a spec, not imported by one at the head or the base, in no spec's modules and
   no endpoint's files (a stylesheet Vite inlines, a module no endpoint ran, a config no rule
   reads); docs, Markdown, the suites that are not E2E and their configs, the lint and format
   configs, the front end's scripts that check the build or write DESIGN.md, or that nothing in
   CI runs, the back end's deploy config, `back-end/vercel.json`, the advisory scan's lock,
   `back-end/requirements-audit.in` and its `.txt`, and the migrations, `back-end/migrations/`
   (`DRIVES_NO_SPEC`), choose nothing, and so does a file the change deletes no rule places, since
   what read it changes with it and is placed on its own.

The chosen specs run by score, the shorter first on a tie, until the next would pass the cap
(`--minutes`, 30 by default) of CI minutes, by the map's run's shard results, then
`front-end/scripts/e2e-shard-timings.json`, then the median of those; a spec the change edits runs
whatever the cap. With no map at all (no `gh`, offline, none made yet) it says so and chooses by
rule 1 alone, which is what Playwright's own `--only-changed` chooses.
`ci` decides what a pull request's E2E run runs, and prints it as one JSON object on stdout: the
specs the map names for the diff, with no cap, but for those the head lacks (`scope` `named`,
their `specs`, and the `shards` they take by their `minutes` of the `suite_minutes`, 0 for none
and never more than `--max-shards`, a whole run's); or the whole suite (`scope` `whole`, `shards`
`--max-shards`), when there is no map, GitHub did not answer, the newest map is more than 7 days
old (`MAP_MAX_AGE_DAYS`), the change names every spec, or a named spec's name holds a character
the run cannot pass on (`SPEC_NAME`). `why` says which, `map` where the map came from, and
`--github` also writes the decision to the run's summary.
`audit`, which CI's `e2e` job runs on a pull request, names each spec that failed in the reports
as ran (the selection runs it), left to CI (it chose it past the cap) or missed (it did not
choose it); `--github` also writes them to the run's summary and, when there is a map, each miss
as a warning annotation. With `--queue`, for a merge queue's trial commit and the commit it was
built on (`--base HEAD^1 --head HEAD`), it judges each failed spec instead by what `ci` decides for
that diff, with no cap (it takes no `--minutes`): ran on the pull request (named), the pull request
ran the whole suite, or left out by the pull request's run, which `--github` also writes as a
warning annotation.
`docs/implementation/testing/the-test-map.md` says what the map holds.

Exit codes: Playwright's with `--run`, 0 with nothing to run, `--list`, `ci` (whatever it
decides) or `audit` (whatever it finds, or when it cannot audit), 2 a usage error.
"""
import argparse
import ast
import io
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tokenize
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Sequence, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_map import counted, function_at, function_spans  # noqa: E402

E2E = "front-end/e2e/"
SRC = "front-end/src/"
TIMINGS = "front-end/scripts/e2e-shard-timings.json"
CACHE = ".stack-logs/test-map"
CAP_MINUTES = 30.0
# A spec with no timing anywhere: a minute.
UNTIMED_SECONDS = 60.0
# CI's pull request run reads no older map: a nightly run that made none for a week is a fault.
MAP_MAX_AGE_DAYS = 7
# The spec names CI's run passes on, to its shards' filters and its jobs' outputs.
SPEC_NAME = re.compile(r"[A-Za-z0-9._+/-]+\.spec\.ts")

# What every spec stands on: the fixtures every test is made from, the setup and config of the
# run, the front end's build and dependencies, and the stack and data every spec runs against:
# every back-end lock but the advisory scan's, which no stack installs. And the E2E run's own
# machinery, so a change to it runs the whole suite: the Test workflow and its shared actions, the
# shard dealer and its timings, this selection and the map's builder, the scripts that give a
# runner its browser's packages and a stack its image tags, and `.nvmrc`, the Node every shard
# installs to run the dealer and Playwright.
RUN_EVERY_SPEC = re.compile(
    r"^(?:front-end/(?:e2e/fixtures\.ts|e2e/global-setup\.ts|playwright\.config\.ts"
    r"|package-lock\.json|vite\.config\.ts|index\.html"
    r"|scripts/(?:e2e-shards\.ts|e2e-shard-timings\.json))"
    r"|docker-compose[^/]*\.ya?ml|(?:.*/)?Dockerfile[^/]*|back-end/requirements(?!-audit\.)[^/]*\.txt"
    r"|scripts/(?:seed_fixture\.sh|lib/stack-identity\.sh|affected-specs\.py|test_map\.py"
    r"|chromium-packages\.sh|image-tags\.sh)"
    r"|\.github/(?:workflows/test\.yml|actions/.+)|\.nvmrc)$"
)

# The changed files that drive no spec, wherever the map places them: the docs, Markdown, the
# suites the E2E run does not run and their configs, the lint and format configs, the front end's
# scripts that check the build or write DESIGN.md (or that nothing in CI runs), the back end's
# deploy config, the advisory scan's lock, which only CI's python-advisories job installs, and the
# migrations, which an operator runs by hand, none of which the stack or a page reads.
DRIVES_NO_SPEC = re.compile(
    r"^(?:docs/|back-end/tests/|back-end/migrations/|front-end/src/__tests__/|scripts/tests/)"
    r"|\.md$|\.test\.ts$"
    r"|^front-end/src/.*\.(?:test|spec)\.tsx?$"
    r"|^front-end/(?:vitest\.config\.ts|tsconfig\.vitest\.json|eslint\.config\.ts"
    r"|stylelint\.config\.js|\.prettierrc\.json|\.prettierignore|\.editorconfig"
    r"|scripts/(?:bundle-budget\.ts|no-eval\.ts|brand-icons\.ts"
    r"|design-md\.ts|design-md-content\.ts))$"
    r"|^back-end/(?:pytest\.ini|vercel\.json|requirements-audit\.(?:in|txt))$"
)

# `import ... from '<x>'`, `export ... from '<x>'`, `import '<x>'` and `import('<x>')`.
IMPORT = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"\n]+)['"]""")


def git(root: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=False
    )
    if done.returncode != 0:
        raise SystemExit(f"affected-specs: git {' '.join(args)}: {done.stderr.strip()}")
    return done.stdout


def git_names(root: Path, command: str, *args: str) -> List[str]:
    """The paths a git command lists, each as it is: without `-z` git quotes a name it finds
    unusual, such as one outside ASCII or holding a quote."""
    return git(root, command, "-z", *args).split("\0")[:-1]


class Tree:
    """The files at one side of the diff: a commit's, or the worktree's when `rev` is None."""

    def __init__(self, root: Path, rev: Optional[str]):
        self.root, self.rev = root, rev
        self._cache: Dict[str, Optional[str]] = {}

    def read(self, path: str) -> Optional[str]:
        if path not in self._cache:
            if self.rev is None:
                file = self.root / path
                self._cache[path] = file.read_text(errors="replace") if file.is_file() else None
            else:
                # `cat-file blob` reads a file alone: `git show` of a directory prints its listing
                # and succeeds, so `./fixtures` would name `e2e/fixtures/` over `fixtures.ts`.
                done = subprocess.run(
                    ["git", "-C", str(self.root), "cat-file", "blob", f"{self.rev}:{path}"],
                    capture_output=True,
                    check=False,
                )
                self._cache[path] = (
                    done.stdout.decode(errors="replace") if done.returncode == 0 else None
                )
        return self._cache[path]

    def files(self, under: str) -> List[str]:
        if self.rev is None:
            top = self.root / under
            found = [
                str(p.relative_to(self.root))
                for p in top.rglob("*")
                if p.is_file() and "node_modules" not in p.parts
            ]
            return sorted(found)
        return git_names(self.root, "ls-tree", "-r", "--name-only", self.rev, "--", under)


HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def header_path(line: str) -> Optional[str]:
    """The path on a diff's `---` or `+++` line; None for no file, and for a name git quotes
    there (one holding a quote, a backslash or a control character), which the listings of names
    give as it is, so its change has no lines and counts whole."""
    if line[4:] == "/dev/null" or line[4:].startswith('"'):
        return None
    # Git ends a name that holds a space with a tab.
    return line[6:].removesuffix("\t")


def changed_lines(root: Path, base: str, head: Optional[str]) -> Dict[str, Tuple[Set[int], Set[int]]]:
    """{path: (head lines changed, base lines changed)} from `base` to `head` or the worktree.

    Only lines a hunk has on each side: a deletion has none on the head side and an addition none
    on the base side, so a deleted function is named by the base's lines alone. An untracked file
    is all head lines.
    """
    options = ["-c", "core.quotePath=false", "diff", "-U0", "--no-renames", "--no-ext-diff",
               "--no-color", "--src-prefix=a/", "--dst-prefix=b/"]  # fmt: skip
    sides = [base] + ([head] if head else [])
    out: Dict[str, Tuple[Set[int], Set[int]]] = defaultdict(lambda: (set(), set()))
    old: Optional[str] = None
    path: Optional[str] = None
    # A file's `---` and `+++` lines stand between its `diff --git` line and its first hunk; further
    # down, a changed line that starts `-- ` or `++ ` reads like one.
    in_header = False
    for line in git(root, *options, *sides, "--").split("\n"):
        if line.startswith("diff --git "):
            old, path, in_header = None, None, True
        elif in_header and line.startswith("--- "):
            old = header_path(line)
        elif in_header and line.startswith("+++ "):
            path = header_path(line) if line != "+++ /dev/null" else old
        elif line.startswith("@@"):
            in_header = False
            m = HUNK.match(line)
            if not m or not path:
                continue
            ostart, ocount = int(m.group(1)), int(m.group(2) or 1)
            start, count = int(m.group(3)), int(m.group(4) or 1)
            out[path][0].update(range(start, start + count))
            out[path][1].update(range(ostart, ostart + ocount))
    # A change with no hunk (a binary file, a change of mode) is a path with no lines.
    for name in git_names(root, "diff", "--name-only", "--no-renames", *sides, "--"):
        out[name]
    if head is None:
        worktree = Tree(root, None)
        for name in git_names(root, "ls-files", "--others", "--exclude-standard"):
            text = worktree.read(name) or ""
            out[name][0].update(range(1, len(text.splitlines()) + 1))
    return dict(out)


QUIET_TOKENS = {
    tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.INDENT, tokenize.DEDENT,
    tokenize.ENDMARKER, tokenize.ENCODING,
}  # fmt: skip


def python_words(source: str) -> Optional[Tuple[Set[int], List[Tuple[int, int]]]]:
    """(the lines that hold something that runs, the first and last line of each docstring) of a
    Python file, or None when it does not parse.

    A docstring is the string that opens a module, class or function body. A line runs nothing
    when it is blank, a comment, or the text of a docstring alone: a `#` inside any other string,
    or code on a docstring's own line, such as a `def` or a `;`, runs."""
    try:
        tree = ast.parse(source)
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (SyntaxError, ValueError, tokenize.TokenError):
        return None
    text = source.split("\n")

    def column(line: int, offset: int) -> int:
        # ast counts a column in UTF-8 bytes, tokenize in characters.
        return len(text[line - 1].encode()[:offset].decode(errors="replace"))

    docstrings: List[Tuple[Tuple[int, int], Tuple[int, int]]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            first = node.body[0] if node.body else None
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
                and first.end_lineno is not None
                and first.end_col_offset is not None
            ):
                start = (first.lineno, column(first.lineno, first.col_offset))
                end = (first.end_lineno, column(first.end_lineno, first.end_col_offset))
                docstrings.append((start, end))
    runs: Set[int] = set()
    for token in tokens:
        if token.type in QUIET_TOKENS:
            continue
        if any(start <= token.start and token.end <= end for start, end in docstrings):
            continue
        runs.update(range(token.start[0], token.end[0] + 1))
    return runs, [(start[0], end[0]) for start, end in docstrings]


def line_count(source: str) -> int:
    return source.count("\n") + (1 if source and not source.endswith("\n") else 0)


def changed_functions(path: str, lines: Tuple[Set[int], Set[int]], head: Tree, base: Tree) -> Set[str]:
    """The functions a change to a Python file touches, by the qualified names the map uses, or
    `<module>` for a line outside every function (or a file whose change has no lines, such as a
    change of mode).

    A line that runs nothing (blank, a comment, a docstring's text) names none, unless the change
    moves a docstring's quotes over a line it leaves that ran on the other side; when either side
    does not parse, a blank or `#` line on both sides names none, and every other line counts."""
    if not lines[0] and not lines[1]:
        return {"<module>"}
    sources = (head.read(path) or "", base.read(path) or "")
    words = [python_words(source) for source in sources]
    # The lines the change leaves, side by side: the diff keeps them in order.
    left = [
        [n for n in range(1, line_count(source) + 1) if n not in side]
        for source, side in zip(sources, lines)
    ]
    same = dict(zip(*left)) if len(left[0]) == len(left[1]) else {}
    across = (same, {b: h for h, b in same.items()})
    found: Set[str] = set()
    for at in (0, 1):
        source, side, read, other = sources[at], lines[at], words[at], words[1 - at]
        spans = function_spans(source)
        if read is None or other is None:
            text = source.splitlines()
            for line in side:
                said = text[line - 1].strip() if 0 < line <= len(text) else ""
                if said and not said.startswith("#"):
                    found.add(function_at(spans, line))
            continue
        runs, docstrings = read

        def ran_across(line: int) -> bool:
            # A line the change leaves that runs on the other side, or one it cannot match there.
            match = across[at].get(line)
            return match is None or match in other[0]

        for line in side:
            if line in runs or any(
                first <= line <= last
                and any(ran_across(n) for n in range(first, last + 1) if n not in side)
                for first, last in docstrings
            ):
                found.add(function_at(spans, line))
    return found


class Unread(Exception):
    """A script or template the scanner cannot be sure of, so its change counts whole."""


# The words after which a `/` opens a regex, not a division.
BEFORE_REGEX = {
    "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do",
    "else", "yield", "await",
}  # fmt: skip
WORD = re.compile(r"[\w$#@]+")
SPACE = re.compile(r"\s+")
TAG = re.compile(r"</?([A-Za-z][\w-]*)")


class Words:
    """What runs of a script or a Vue file: its text with its comments out and each run of white
    space outside a string, a template, a regex, a tag, an interpolation or the text of a `<style>`,
    `<pre>`, `<textarea>` or `<title>` as one space, or one line break when it held one (on which a
    statement may end), a script's comment counting as such a run and a template's, but an inline
    one, as nothing (`vue`), so two whose comments alone differ, in the same white space, read the
    same.

    A `/` after a value (a word, a literal, `)`, `]` or `}`) is read as a division, and after
    anything else, or a word such as `return`, as opening a regex: a regex just after a `)` or a
    `}` is read wrong, which a formatted file does not hold."""

    def __init__(self, text: str) -> None:
        self.text, self.at = text, 0
        self.out: List[str] = []
        self.space = ""
        self.value = False  # whether the last piece put was a value, after which `/` divides

    def put(self, piece: str, value: bool) -> None:
        if self.space and self.out:
            self.out.append(self.space)
        self.out.append(piece)
        self.space, self.value = "", value

    def gap(self, space: str) -> None:
        self.space = "\n" if "\n" in space or self.space == "\n" else " "

    def till(self, end: str, start: int) -> int:
        """Where the first `end` from `start` ends."""
        found = self.text.find(end, start)
        if found < 0:
            raise Unread(f"no {end!r}")
        return found + len(end)

    def script(self, in_template: bool = False) -> None:
        """Read code to the end, or to the `}` that closes a template's `${`."""
        text, depth = self.text, 0
        while self.at < len(text):
            c, at = text[self.at], self.at
            if c.isspace():
                space = SPACE.match(text, at)
                assert space
                self.gap(space.group())
                self.at = space.end()
            elif text.startswith("//", at):
                end = text.find("\n", at)
                self.at = len(text) if end < 0 else end
            elif text.startswith("/*", at):
                self.at = self.till("*/", at + 2)
                self.gap("\n" if "\n" in text[at : self.at] else " ")
            elif c in "'\"":
                self.at = self.quoted(c, at + 1)
                self.put(text[at : self.at], True)
            elif c == "`":
                self.template()
            elif c == "/" and not self.value:
                self.at = self.regex(at + 1)
                self.put(text[at : self.at], True)
            elif c == "}" and in_template and depth == 0:
                return
            else:
                word = WORD.match(text, at)
                self.at = word.end() if word else at + 1
                piece = text[at : self.at]
                depth += {"{": 1, "}": -1}.get(piece, 0)
                self.put(piece, piece in ")]}" if not word else piece not in BEFORE_REGEX)
        if in_template:
            raise Unread("an unclosed template")

    def quoted(self, quote: str, at: int) -> int:
        """Where a string that opened before `at` ends."""
        text = self.text
        while at < len(text) and text[at] != "\n":
            if text[at] == quote:
                return at + 1
            at += 2 if text[at] == "\\" else 1
        raise Unread("an unclosed string")

    def regex(self, at: int) -> int:
        """Where a regex that opened before `at` ends, its flags included."""
        text, in_class = self.text, False
        while at < len(text) and text[at] != "\n":
            c = text[at]
            if c == "/" and not in_class:
                flags = WORD.match(text, at + 1)
                return flags.end() if flags else at + 1
            if c == "[" or c == "]":
                in_class = c == "["
            at += 2 if c == "\\" else 1
        raise Unread("an unclosed regex")

    def template(self) -> None:
        text, start = self.text, self.at
        at = start + 1
        while at < len(text):
            if text[at] == "`":
                self.at = at + 1
                self.put(text[start : self.at], True)
                return
            if text.startswith("${", at):
                self.put(text[start : at + 2], False)
                self.at = at + 2
                self.script(in_template=True)
                self.put("}", False)
                start = at = self.at = self.at + 1
                continue
            at += 2 if text[at] == "\\" else 1
        raise Unread("an unclosed template")

    def vue(self) -> None:
        """Read a Vue file: its `<script>` blocks as scripts, the rest as a template, whose
        `<!-- -->` comments read as nothing, but one with white space beside it on its line and no
        line break there, which is kept; a tag, an interpolation and the text of a `<style>`,
        `<pre>`, `<textarea>` or `<title>` are kept as written."""
        text = self.text
        while self.at < len(text):
            c, at = text[self.at], self.at
            if c.isspace():
                space = SPACE.match(text, at)
                assert space
                self.gap(space.group())
                self.at = space.end()
            elif text.startswith("<!--", at):
                self.at = self.till("-->", at + 4)
                after = SPACE.match(text, self.at)
                around = self.space + (after.group() if after else "")
                if around and "\n" not in around:
                    # Vue's dev build keeps the comment and drops the white space between it and an
                    # element, so one with white space beside it and no line break is code.
                    self.put(text[at : self.at], False)
            elif text.startswith("{{", at):
                self.at = self.till("}}", at + 2)
                self.put(text[at : self.at], False)
            elif TAG.match(text, at):
                self.tag()
            else:
                self.put(c, False)
                self.at += 1

    def tag(self) -> None:
        text, start = self.text, self.at
        at = start + 1
        while at < len(text) and text[at] != ">":
            at = self.till(text[at], at + 1) if text[at] in "'\"" else at + 1
        if at >= len(text):
            raise Unread("an unclosed tag")
        self.at = at + 1
        opened = text[start : self.at]
        self.put(opened, False)
        name = TAG.match(opened)
        assert name
        tag = name.group(1).lower()
        if opened.startswith("</") or opened.endswith("/>"):
            return
        if tag == "script":
            if re.search(r"\blang\s*=\s*['\"](?!ts['\"])", opened):
                raise Unread("a script in another language")
            # Vue ends a script at its first `</script`, wherever it stands.
            end = self.till("</script", self.at) - len("</script")
            block = Words(text[self.at : end])
            block.script()
            self.put("".join(block.out), False)
            self.at = end
        elif tag == "template" and re.search(r"\blang\s*=", opened):
            raise Unread("a template in another language")
        elif tag in ("style", "pre", "textarea", "title"):
            end = self.till(f"</{tag}", self.at) - len(tag) - 2
            self.put(text[self.at : end], False)
            self.at = end

    def read(self, vue: bool) -> str:
        if vue:
            self.vue()
        else:
            self.script()
        return "".join(self.out)


def front_end_words(path: str, source: Optional[str]) -> Optional[str]:
    """What runs of a front-end `.ts` or `.vue` file, by `Words`, or None when there is no file or
    the scanner cannot be sure of it."""
    if source is None:
        return None
    try:
        return Words(source).read(path.endswith(".vue"))
    except Unread:
        return None


def words_only(path: str, head: Tree, base: Tree) -> bool:
    """Whether a change to a file under `front-end/src/` changes its comments alone, so nothing that
    runs: its `.ts` or `.vue` file, at both sides, reads the same with its comments out."""
    if not (path.startswith(SRC) and path.endswith((".ts", ".vue"))):
        return False
    after = front_end_words(path, head.read(path))
    return after is not None and after == front_end_words(path, base.read(path))


def resolve(importer: str, target: str, tree: Tree) -> Optional[str]:
    """The repository path a relative (or `@/`) import of a front-end file names, if it is one."""
    if target.startswith("@/"):
        joined = SRC + target[2:]
    elif target.startswith("."):
        parts = importer.split("/")[:-1]
        for part in target.split("/"):
            if part == "..":
                parts = parts[:-1]
            elif part != ".":
                parts.append(part)
        joined = "/".join(parts)
    else:
        return None
    for candidate in (joined, joined + ".ts", joined + "/index.ts"):
        if tree.read(candidate) is not None:
            return candidate
    return joined


def import_closure(spec_path: str, tree: Tree) -> Set[str]:
    """Every file a spec imports, transitively, by repository path; front-end files only."""
    seen: Set[str] = set()
    todo = [spec_path]
    while todo:
        current = todo.pop()
        text = tree.read(current)
        if text is None or not current.endswith((".ts", ".mts", ".js", ".vue")):
            continue
        for target in IMPORT.findall(text):
            found = resolve(current, target, tree)
            if found and found not in seen and found != spec_path:
                seen.add(found)
                todo.append(found)
    return seen


def short(path: str) -> str:
    return path[len(E2E) :] if path.startswith(E2E) else path


class Selection:
    def __init__(self) -> None:
        self.score: Dict[str, float] = defaultdict(float)
        self.why: Dict[str, List[str]] = defaultdict(list)
        self.changed: Set[str] = set()

    def add(self, spec: str, score: float, why: str) -> None:
        self.score[spec] += score
        if why not in self.why[spec]:
            self.why[spec].append(why)


def select(
    changes: Dict[str, Tuple[Set[int], Set[int]]],
    head: Tree,
    base: Tree,
    test_map: Optional[dict],
) -> Tuple[Selection, Set[str]]:
    """The specs the change reaches, and the specs at the head; with no map, by rule 1 alone."""
    selection = Selection()
    # A change to a front-end module's comments alone runs nothing, so it reaches no spec.
    changes = {p: lines for p, lines in changes.items() if not words_only(p, head, base)}
    at_head = {short(p) for p in head.files(E2E) if p.endswith(".spec.ts")}
    deleted = {short(p) for p in changes if p.startswith(E2E) and short(p) not in at_head}
    # The files the change deletes: at the base, gone at the head.
    gone = {p for p in changes if head.read(p) is None and base.read(p) is not None}
    at_base = {short(p) for p in base.files(E2E) if p.endswith(".spec.ts")}
    imported_at_base = {spec: import_closure(E2E + spec, base) for spec in sorted(at_base)}

    # Rule 1: a changed spec, every spec importing a changed file, and every spec that imported a
    # file the change deletes, which its imports at the head no longer name.
    imported_at_head: Set[str] = set()
    for spec in sorted(at_head):
        path = E2E + spec
        if path in changes:
            selection.add(spec, 1, "changed spec")
            selection.changed.add(spec)
        closure = import_closure(path, head)
        imported_at_head |= closure
        for imported in sorted(closure):
            if imported in changes:
                selection.add(spec, 1, f"imports {short(imported)}")
        for imported in sorted((imported_at_base.get(spec, set()) & gone) - closure):
            selection.add(spec, 1, f"imported {short(imported)}, which the change deletes")
    if test_map is None:
        return selection, at_head

    specs = {s: v for s, v in test_map["specs"].items() if s not in deleted}
    universe = (set(specs) | at_head) - deleted
    by_module: Dict[str, Set[str]] = defaultdict(set)
    by_endpoint: Dict[str, Set[str]] = defaultdict(set)
    for spec, reached in specs.items():
        for module in reached["modules"]:
            by_module[module].add(spec)
        for endpoint in reached["endpoints"]:
            by_endpoint[endpoint].add(spec)
    endpoints: Dict[str, Dict[str, List[str]]] = test_map["endpoints"]
    in_endpoints = {path for files in endpoints.values() for path in files}
    # A file is placed when a rule can read it, whatever this change reaches through it: a spec,
    # a file a spec imports at the head or the base (so a deleted helper too), a module a spec's
    # pages loaded, a back-end file an endpoint ran, or a file every spec stands on.
    placed = set(imported_at_head) | set(by_module) | in_endpoints
    for spec, closure in imported_at_base.items():
        placed.add(E2E + spec)
        placed |= closure
    placed |= {E2E + spec for spec in at_head | set(test_map["specs"])}

    for path, lines in sorted(changes.items()):
        # Rule 5: a file no rule places may drive any spec, unless the change deletes it: what
        # read it changes with it, and is placed on its own.
        if (
            path.startswith(("front-end/", "back-end/"))
            and not DRIVES_NO_SPEC.search(path)
            and not RUN_EVERY_SPEC.match(path)
            and path not in placed
            and path not in gone
        ):
            for spec in sorted(universe):
                selection.add(spec, 0, f"{path} is not in the map")
            continue
        # Rule 4: every spec.
        if RUN_EVERY_SPEC.match(path):
            for spec in sorted(universe):
                selection.add(spec, 0, f"{path} runs every spec")
        # Rule 2: a module the spec's pages loaded.
        if path.startswith(SRC):
            reached = by_module.get(path, set())
            for spec in sorted(reached):
                selection.add(spec, 1 / len(reached), f"loads {path} (1/{len(reached)})")
        # Rule 3: a back-end function an endpoint the spec called runs.
        if path.startswith("back-end/") and path.endswith(".py"):
            if path.startswith("back-end/tests/"):
                continue
            known = {fn for files in endpoints.values() for fn in files.get(path, ())}
            whole_file = False
            for function in sorted(changed_functions(path, lines, head, base)):
                if function not in known:
                    whole_file = True
                    continue
                via: Dict[str, str] = {}
                for endpoint in sorted(endpoints):
                    if function in endpoints[endpoint].get(path, ()):
                        for spec in by_endpoint.get(endpoint, ()):
                            via.setdefault(spec, endpoint)
                for spec in sorted(via):
                    selection.add(
                        spec,
                        1 / len(via),
                        f"{path}:{function} via {via[spec]} (1/{len(via)})",
                    )
            if whole_file:
                reached = set()
                for endpoint, files in endpoints.items():
                    if path in files:
                        reached |= by_endpoint.get(endpoint, set())
                for spec in sorted(reached):
                    selection.add(spec, 0, f"{path}, outside any function the map knows")
    for spec in list(selection.score):
        if spec not in universe:
            del selection.score[spec]
    return selection, at_head


def report_seconds(directory: Path) -> Dict[str, float]:
    """Each spec file's seconds over the Playwright JSON reports under `directory`, every attempt
    counted, as `front-end/scripts/e2e-shards.ts refresh` sums them."""

    def milliseconds(suite: dict) -> float:
        total = 0.0
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                for result in test.get("results", []):
                    total += result.get("duration", 0)
        return total + sum(milliseconds(inner) for inner in suite.get("suites", []))

    sums: Dict[str, float] = defaultdict(float)
    for report in sorted(directory.rglob("*.json")) if directory.is_dir() else []:
        try:
            data = json.loads(report.read_text())
        except (OSError, ValueError):
            continue
        for suite in data.get("suites", []):
            if suite.get("file"):
                sums[suite["file"]] += milliseconds(suite)
    return {spec: total / 1000 for spec, total in sums.items()}


class Seconds:
    """A spec's CI seconds: the shard results, then the committed timings, then their median."""

    def __init__(self, results: Optional[Path], timings: Optional[str]):
        self.results = report_seconds(results) if results else {}
        try:
            self.timings = {k: float(v) for k, v in json.loads(timings or "{}").items()}
        except ValueError:
            self.timings = {}
        known = list({**self.timings, **self.results}.values())
        self.median = statistics.median(known) if known else UNTIMED_SECONDS

    def __call__(self, spec: str) -> float:
        return self.results.get(spec, self.timings.get(spec, self.median))


def ranked(selection: Selection, seconds: Seconds, cap: float) -> Tuple[List[dict], List[dict]]:
    """The specs to run and the specs left to CI, each in score order, the shorter first on a tie;
    the run stops at the first spec past the cap, but a changed spec runs whatever the cap."""
    order = sorted(selection.score, key=lambda s: (-selection.score[s], seconds(s), s))
    run: List[dict] = []
    left: List[dict] = []
    minutes = 0.0
    stopped = False
    for rank, spec in enumerate(order, start=1):
        row = {
            "rank": rank,
            "spec": spec,
            "score": selection.score[spec],
            "minutes": seconds(spec) / 60,
            "changed": spec in selection.changed,
            "why": selection.why[spec],
        }
        if row["changed"] or (not stopped and minutes + row["minutes"] <= cap):
            run.append(row)
            minutes += row["minutes"]
        else:
            stopped = True
            left.append(row)
    return run, left


def gh(root: Path, *args: str) -> Optional[str]:
    try:
        done = subprocess.run(
            ["gh", *args], cwd=root, capture_output=True, text=True, timeout=300, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def newest_map(root: Path) -> Tuple[Optional[dict], Optional[dict], Optional[Path]]:
    """(the map, where it came from, its run's shard results) of the newest run on `dev` that
    made one (a nightly run's, or an older push's), downloaded once a run; offline, the newest one
    downloaded before."""
    cache = root / CACHE
    listing = gh(root, "api", "repos/{owner}/{repo}/actions/artifacts?name=test-map&per_page=50")
    run_id: Optional[int] = None
    made = ""
    if listing is not None:
        try:
            artifacts = json.loads(listing).get("artifacts", [])
        except ValueError:
            artifacts = []
        on_dev = [
            a
            for a in artifacts
            if a.get("name") == "test-map"
            and not a.get("expired")
            and (a.get("workflow_run") or {}).get("head_branch") == "dev"
        ]
        on_dev.sort(key=lambda a: a.get("created_at", ""), reverse=True)
        if on_dev:
            run_id = int(on_dev[0]["workflow_run"]["id"])
            made = on_dev[0].get("created_at", "")
            if not (cache / str(run_id) / "test-map.json").is_file():
                download(root, cache, run_id)
    if run_id is None or not (cache / str(run_id) / "test-map.json").is_file():
        offline = listing is None or run_id is not None
        earlier = sorted(
            (int(d.name) for d in cache.iterdir() if d.name.isdigit() and (d / "test-map.json").is_file())
            if cache.is_dir()
            else []
        )
        if not earlier or not offline:
            return None, None, None
        run_id = earlier[-1]
        source = {"run": run_id, "offline": True}
    else:
        source = {"run": run_id, "offline": False, "made": made}
    folder = cache / str(run_id)
    test_map = json.loads((folder / "test-map.json").read_text())
    source["commit"] = test_map.get("commit")
    source["path"] = str(folder.relative_to(root))
    return test_map, source, folder / "results"


def download(root: Path, cache: Path, run_id: int) -> None:
    """The run's `test-map` and its shards' Playwright reports, into `<cache>/<run id>/`, whole or
    not at all: a partial download is in a directory of its own until it is complete."""
    partial = cache / f".{run_id}.{os.getpid()}"
    shutil.rmtree(partial, ignore_errors=True)
    partial.mkdir(parents=True)
    try:
        if gh(root, "run", "download", str(run_id), "-n", "test-map", "-D", str(partial)) is None:
            return
        if not (partial / "test-map.json").is_file():
            return
        # The shard results are only the minutes: the committed timings stand in without them.
        gh(root, "run", "download", str(run_id), "-p", "e2e-results-shard-*",
           "-D", str(partial / "results"))  # fmt: skip
        try:
            partial.rename(cache / str(run_id))
        except OSError:
            return  # another run of this script downloaded it first
        # Only the newest map is read again, offline: the older ones go.
        for older in cache.iterdir():
            if older.name.isdigit() and int(older.name) < run_id:
                shutil.rmtree(older, ignore_errors=True)
    finally:
        shutil.rmtree(partial, ignore_errors=True)


def escape(text: str) -> str:
    """A path for a Playwright filter, `/source/` and all, as front-end/scripts/e2e-shards.ts
    escapes it."""
    return re.sub(r"([.*+?^${}()|\[\]\\/])", r"\\\1", text)


def describe_source(source: Optional[dict]) -> str:
    if source is None:
        return (
            "affected-specs: no test map (no `gh`, offline, or no run on dev has made one yet): "
            "choosing only the changed specs and those importing a changed file, as Playwright's "
            "--only-changed would"
        )
    commit = (source.get("commit") or "")[:8]
    if "file" in source:
        return f"affected-specs: the test map {source['file']}, at {commit}"
    if source.get("offline"):
        return (
            f"affected-specs: GitHub did not answer: the test map of dev run {source['run']}, "
            f"at {commit}, downloaded before to {source['path']}"
        )
    return f"affected-specs: the test map of dev run {source['run']}, at {commit}, in {source['path']}"


def capitalize_first(text: str) -> str:
    return text[:1].upper() + text[1:]


def reasons(row: dict) -> str:
    """A row's first three reasons, and how many more."""
    why = row["why"][:3] + ([f"and {len(row['why']) - 3} more"] if len(row["why"]) > 3 else [])
    return "; ".join(why)


def print_rows(rows: Sequence[dict], absent: Set[str]) -> None:
    for row in rows:
        mark = " (not in this tree)" if row["spec"] in absent else ""
        print(
            f"  {row['rank']:>4} {row['minutes']:>6.1f} min  {row['score']:6.3f}  "
            f"{row['spec']}{mark}: {reasons(row)}"
        )


class Chosen:
    """What the selection chooses for one diff: the shared work of `--list`, `--run`, `ci` and
    `audit`."""

    def __init__(self, args: argparse.Namespace, drop_absent: bool):
        self.root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").strip())
        base = args.base or git(self.root, "merge-base", "origin/dev", "HEAD").strip()
        self.base = git(self.root, "rev-parse", "--verify", f"{base}^{{commit}}").strip()
        self.head_rev = (
            git(self.root, "rev-parse", "--verify", f"{args.head}^{{commit}}").strip()
            if args.head
            else None
        )
        head, base_tree = Tree(self.root, self.head_rev), Tree(self.root, self.base)
        if args.map:
            test_map = json.loads(args.map.read_text())
            self.source: Optional[dict] = {"file": str(args.map), "commit": test_map.get("commit")}
            results = args.results
        else:
            test_map, self.source, results = newest_map(self.root)
            results = args.results or results
        self.seconds = Seconds(results, head.read(TIMINGS))
        self.changes = changed_lines(self.root, self.base, self.head_rev)
        selection, self.at_head = select(self.changes, head, base_tree, test_map)
        self.absent = set(selection.score) - self.at_head
        if drop_absent:
            for spec in self.absent:
                del selection.score[spec]
        self.run, self.left = ranked(selection, self.seconds, args.minutes)
        self.minutes = args.minutes
        self.base_named = bool(args.base)

    def describe_diff(self) -> str:
        return (
            f"{counted(len(self.changes), 'file')} changed from {self.base[:8]} "
            f"({'--base' if self.base_named else 'the merge-base with origin/dev'}) "
            f"to {self.head_rev[:8] if self.head_rev else 'the worktree'}"
        )

    def describe_basis(self) -> str:
        """What the selection was made from, as a sentence: the map, then the diff."""
        source = describe_source(self.source).replace("affected-specs: ", "", 1)
        return f"{capitalize_first(source)}; {self.describe_diff()}."

    def describe_ci_basis(self) -> str:
        """The basis of what `ci` decides: with no map there is none to describe, and
        `describe_source` then tells of the choice a builder's run falls back to, which CI's run
        does not make."""
        return self.describe_basis() if self.source else f"{self.describe_diff()}."


def selection_options(parser: argparse.ArgumentParser, capped: bool = True) -> None:
    """The options that name a selection's diff and map, and its cap unless it has none."""
    parser.add_argument("--base", help="the base of the diff (the merge-base with origin/dev)")
    parser.add_argument("--head", help="the head of the diff, a commit (the worktree)")
    parser.add_argument("--map", type=Path, help="a test-map.json in place of the newest dev's")
    parser.add_argument("--results", type=Path, help="Playwright JSON reports for the minutes")
    if capped:
        parser.add_argument(
            "--minutes", type=float, default=CAP_MINUTES, help="the cap, in CI minutes"
        )
    else:
        parser.set_defaults(minutes=math.inf)


# The outcomes of a test that fail a shard.
FAILED = ("unexpected", "flaky")


def failed_specs(reports: Sequence[Path]) -> Tuple[Set[str], List[str]]:
    """The spec files with a failed test in Playwright JSON reports, and the reports it could not
    read. A test failed when its outcome is `unexpected`, or `flaky`: it passed only on a retry,
    which under CI fails its shard (`failOnFlakyTests`). A test is named by its top-level suite's
    file, the spec file Playwright loaded, never by its own `file`, which is where its `test()`
    call is: a helper's, for the tests `helpers/screenSweeps.ts` registers."""
    failed: Set[str] = set()
    unread: List[str] = []

    def walk(suite: dict, file: str) -> None:
        for spec in suite.get("specs", []):
            if any(test.get("status") in FAILED for test in spec.get("tests", [])):
                failed.add(file)
        for inner in suite.get("suites", []):
            walk(inner, file)

    for report in reports:
        try:
            for suite in json.loads(Path(report).read_text()).get("suites", []):
                walk(suite, suite.get("file", ""))
        except (OSError, ValueError, AttributeError, TypeError):
            unread.append(str(report))
    return failed, unread


def verdicts(failed: Set[str], chosen: Chosen) -> List[Tuple[str, str, str]]:
    """(spec, verdict, why) for each failed spec: `ran` when the selection runs it, so the builder
    saw it fail; `left to CI` when it chose it past the cap; `missed` when it did not choose it."""
    run = {row["spec"]: row for row in chosen.run}
    left = {row["spec"]: row for row in chosen.left}
    out = []
    for spec in sorted(failed):
        if spec in run:
            row = run[spec]
            out.append((spec, "ran", f"rank {row['rank']}: {reasons(row)}"))
        elif spec in left:
            row = left[spec]
            out.append((
                spec,
                "left to CI",
                f"rank {row['rank']}, past the cap of {counted(chosen.minutes, 'CI minute')}: "
                + reasons(row),
            ))  # fmt: skip
        elif chosen.source is None:
            out.append((spec, "missed", "not chosen: with no test map the selection is rule 1 alone"))
        else:
            out.append((spec, "missed", "not chosen for this change"))
    return out


# The queue audit's verdict on a spec the pull request's run did not run.
LEFT_OUT = "left out by the pull request's run"


def queue_verdicts(failed: Set[str], chosen: Chosen, decision: dict) -> List[Tuple[str, str, str]]:
    """(spec, verdict, why) for each failed spec of a merge queue's run, by what `ci` decides for
    the trial commit's diff: whether the pull request's own E2E run ran it, by name or within the
    whole suite, or left it out."""
    rows = {row["spec"]: row for row in chosen.run}
    out = []
    for spec in sorted(failed):
        if decision["scope"] == "whole":
            out.append((spec, "the pull request ran the whole suite", decision["why"]))
        elif spec in decision["specs"]:
            out.append((spec, "ran on the pull request", reasons(rows[spec])))
        else:
            out.append((spec, LEFT_OUT, "not named for this change"))
    return out


def annotation(text: str) -> str:
    """Text for a GitHub workflow command's message."""
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def some(paths: Sequence[str], at_most: int = 20) -> str:
    shown = ", ".join(paths[:at_most])
    return shown + (f" and {len(paths) - at_most} more" if len(paths) > at_most else "")


class Wording(NamedTuple):
    """What an audit's report says: the pull request's, or the merge queue's."""

    title: str
    # The verdict the summary shows bold and `--github` annotates, with the annotation's title and
    # what it says of the run that did not run the spec.
    flagged: str
    warning_title: str
    warning_clause: str
    closing: str


PULL_REQUEST_AUDIT = Wording(
    title="### E2E selection audit",
    flagged="missed",
    warning_title="A miss of the selection",
    warning_clause="affected-specs.py would not have chosen it",
    closing="A spec that ran is one `affected-specs.py --run` runs for this change, so its "
    "builder could have seen it fail; one left to CI was chosen past the cap; a miss "
    "is one it would not have chosen at all, from a map that drifted or a dependency "
    "its rules cannot see (`docs/implementation/testing/the-test-map.md`).",
)
QUEUE_AUDIT = Wording(
    title="### E2E selection audit (merge queue)",
    flagged=LEFT_OUT,
    warning_title="A spec the pull request's run left out",
    warning_clause="the pull request's own E2E run would not have run it",
    closing="A spec left out is one the pull request's run did not run, so a failure there met "
    "the queue first. This audit decides again what that run ran, for this diff and by the test "
    "map as it reads it now, so a `dev` that moved since, a map made since, grown too old or not "
    "read, or a selection that failed then, can give a verdict that run did not "
    "(`docs/implementation/testing/the-test-map.md`).",
)


def audit(argv: Sequence[str]) -> int:
    """Each spec that failed in the reports, as ran, left to CI or missed by the selection for the
    diff, or with `--queue` by what `ci`, deciding again now, says the pull request's run ran or
    left out; exits 0 whatever it finds, or when it cannot audit at all."""
    parser = argparse.ArgumentParser(
        prog="affected-specs.py audit",
        description="Each failed spec of Playwright JSON reports, as the selection would have "
        "treated it: ran, left to CI or missed; with --queue, as `ci` decides now for the pull "
        "request's run.",
    )
    parser.add_argument("reports", nargs="*", type=Path, help="the run's Playwright JSON reports")
    selection_options(parser)
    # A cap left unsaid is told apart from one given as the default: `--queue` takes none.
    parser.set_defaults(minutes=None)
    parser.add_argument(
        "--queue",
        action="store_true",
        help="judge each failed spec by what `ci` decides for the diff, a merge queue trial "
        "commit's: ran on the pull request, within its whole suite, or left out",
    )
    parser.add_argument(
        "--github",
        action="store_true",
        help="also write the verdicts to $GITHUB_STEP_SUMMARY and, when there is a map, each miss "
        "(with --queue, each spec left out) as a warning annotation",
    )
    args = parser.parse_args(argv)
    if args.queue and args.minutes is not None:
        parser.error(
            "--queue judges the pull request's run, which has no cap: it takes no --minutes"
        )
    if args.minutes is None:
        args.minutes = math.inf if args.queue else CAP_MINUTES
    wording = QUEUE_AUDIT if args.queue else PULL_REQUEST_AUDIT
    summary: List[str] = [wording.title, ""]
    failed, unread = failed_specs(args.reports)
    read = len(args.reports) - len(unread)
    try:
        if not failed:
            # No report read is no sign that nothing failed: the results' download failed, every
            # shard stopped before Playwright wrote its report, or the selection named no spec,
            # so no shard ran.
            line = (
                "no shard report was read: nothing to audit"
                if read == 0
                else f"no test failed in the {counted(read, 'report')} read: no failure to audit"
            )
            print(f"affected-specs audit: {line}")
            summary.append(f"{capitalize_first(line)}.")
        else:
            # As `--run` ranks them: a spec the map names that the head lacks takes no minutes.
            chosen = Chosen(args, drop_absent=True)
            if args.queue:
                decision = ci_decision(chosen, datetime.now(timezone.utc))
                found = queue_verdicts(failed, chosen, decision)
                source = chosen.describe_ci_basis()
                print(f"affected-specs audit: {source}")
                basis = [source, "", f"The decision for this diff: {decision['why']}."]
            else:
                found = verdicts(failed, chosen)
                basis = [chosen.describe_basis()]
                print(describe_source(chosen.source))
                print(f"affected-specs: {chosen.describe_diff()}")
            changed = sorted(chosen.changes)
            print(
                f"affected-specs audit: {counted(len(found), 'failed spec')}, "
                f"in {counted(read, 'report')}:"
            )
            for spec, verdict, why in found:
                print(f"  {verdict}: {spec}: {why}")
                # With no map there is no map to have drifted: the summary lists the spec alone.
                if verdict == wording.flagged and args.github and chosen.source is not None:
                    print(
                        f"::warning title={wording.warning_title}::"
                        + annotation(
                            f"{spec} failed, and {wording.warning_clause} for this change of "
                            f"{counted(len(changed), 'file')}: {some(changed)}"
                        )
                    )
            summary += [
                *basis,
                "",
                "| Failed spec | Verdict | Why |",
                "|---|---|---|",
            ]
            for spec, verdict, why in found:
                shown = f"**{verdict}**" if verdict == wording.flagged else verdict
                summary.append(f"| `{spec}` | {shown} | {cell(why)} |")
            summary += [
                "",
                wording.closing,
                "",
                f"<details><summary>The {counted(len(changed), 'changed file')}</summary>",
                "",
                *[f"- `{path}`" for path in changed],
                "",
                "</details>",
            ]
    except (SystemExit, Exception) as error:  # noqa: BLE001: the audit never fails its job
        reason = error.code if isinstance(error, SystemExit) else repr(error)
        print(f"affected-specs audit: could not audit: {reason}")
        summary.append(f"The audit could not run: `{reason}`.")
    if unread:
        print(f"affected-specs audit: could not read {', '.join(unread)}")
        summary += ["", f"Could not read {', '.join(f'`{path}`' for path in unread)}."]
    if args.github:
        write_summary(summary)
    return 0


def write_summary(lines: Sequence[str]) -> None:
    """Append a section to the job's summary, when there is one."""
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as out:
            out.write("\n".join(lines) + "\n")


def ci_decision(chosen: Chosen, now: datetime) -> dict:
    """Whether a pull request's E2E run runs the whole suite or the specs the map names, which,
    and why; `chosen` has no cap. Any doubt runs the whole suite."""
    if chosen.source is None:
        return whole_suite("there is no test map")
    if chosen.source.get("offline"):
        return whole_suite("the test map could not be read from GitHub")
    # A map given by `--map` carries no date, so it is never too old.
    if "made" in chosen.source:
        age = now - datetime.fromisoformat(chosen.source["made"].replace("Z", "+00:00"))
        if age > timedelta(days=MAP_MAX_AGE_DAYS):
            return whole_suite(f"the newest test map is {age.days} days old")
    specs = sorted(row["spec"] for row in chosen.run)
    if set(specs) == chosen.at_head:
        return whole_suite("the change names every spec")
    for spec in specs:
        if not SPEC_NAME.fullmatch(spec):
            return whole_suite(f"a spec name the run cannot pass on: {spec}")
    names = counted(len(specs), "spec file") if specs else "no spec"
    return {"scope": "named", "why": f"the test map names {names} for this change", "specs": specs}


def whole_suite(why: str) -> dict:
    return {"scope": "whole", "why": why, "specs": []}


def named_table(chosen: Chosen, specs: Sequence[str]) -> List[str]:
    """The named specs, folded in a job summary, each with its minutes and why it was chosen."""
    if not specs:
        return []
    rows = {row["spec"]: row for row in chosen.run}
    return [
        "",
        f"<details><summary>The {counted(len(specs), 'spec file')} named</summary>",
        "",
        "| Spec | Minutes | Why |",
        "|---|---|---|",
        *[
            f"| `{spec}` | {rows[spec]['minutes']:.1f} | {cell(reasons(rows[spec]))} |"
            for spec in specs
        ],
        "",
        "</details>",
    ]


def shard_count(
    specs: Sequence[str], seconds: Seconds, at_head: Set[str], max_shards: int
) -> int:
    """The shards a named run takes, so that each holds about a whole run's share of the suite, by
    its minutes: never more than the specs or a whole run's `max_shards`, and none for no spec."""
    if not specs:
        return 0
    named = sum(seconds(spec) for spec in specs)
    suite = sum(seconds(spec) for spec in at_head)
    return max(1, min(max_shards, len(specs), math.ceil(named / (suite / max_shards))))


def summary_sentence(output: dict) -> str:
    """The sentence a run's summary opens with, from what `ci` prints."""
    if output["scope"] == "whole":
        return f"Ran the whole suite: {output['why']}."
    if not output["specs"]:
        return "No E2E spec ran: the test map names none for this change."
    return (
        f"Ran the {counted(len(output['specs']), 'spec file')} the test map names for this "
        f"change, {output['minutes']:.1f} of {output['suite_minutes']:.1f} minutes, "
        f"on {counted(output['shards'], 'shard')}."
    )


def ci(argv: Sequence[str]) -> int:
    """What a pull request's E2E run runs, as one JSON object on stdout."""
    parser = argparse.ArgumentParser(
        prog="affected-specs.py ci",
        description="What a pull request's E2E run runs, as one JSON object on stdout.",
    )
    # A pull request's run runs every spec the map names.
    selection_options(parser, capped=False)
    parser.add_argument(
        "--max-shards", type=int, required=True, help="the shards a whole run takes"
    )
    parser.add_argument(
        "--github",
        action="store_true",
        help="also write the decision and its reasons to $GITHUB_STEP_SUMMARY",
    )
    args = parser.parse_args(argv)
    if args.max_shards < 1:
        parser.error("--max-shards is at least 1")
    chosen = Chosen(args, drop_absent=True)
    decision = ci_decision(chosen, datetime.now(timezone.utc))
    named = decision["specs"]
    output = {
        **decision,
        "shards": shard_count(named, chosen.seconds, chosen.at_head, args.max_shards)
        if decision["scope"] == "named"
        else args.max_shards,
        "minutes": sum(chosen.seconds(spec) for spec in named) / 60,
        "suite_minutes": sum(chosen.seconds(spec) for spec in chosen.at_head) / 60,
        "map": chosen.source,
    }
    ran = summary_sentence(output)
    basis = chosen.describe_ci_basis()
    print(f"affected-specs ci: {ran}\naffected-specs ci: {basis}", file=sys.stderr)
    if args.github:
        write_summary(["### E2E selection", "", ran, "", basis, *named_table(chosen, named)])
    print(json.dumps(output))
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ["audit"]:
        return audit(argv[1:])
    if argv[:1] == ["ci"]:
        return ci(argv[1:])
    playwright_args: List[str] = []
    if "--" in argv:
        at = argv.index("--")
        argv, playwright_args = argv[:at], argv[at + 1 :]
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    what = parser.add_mutually_exclusive_group(required=True)
    what.add_argument("--run", action="store_true", help="run the chosen specs with Playwright")
    what.add_argument("--list", action="store_true", help="print the chosen specs, running none")
    selection_options(parser)
    parser.add_argument("--json", action="store_true", help="--list as JSON")
    args = parser.parse_args(argv)
    if args.head and args.run:
        parser.error("--head is for --list: --run runs the worktree's own specs")

    chosen = Chosen(args, drop_absent=args.run)
    run, left, absent = chosen.run, chosen.left, chosen.absent

    if args.json:
        print(json.dumps({
            "base": chosen.base, "head": chosen.head_rev, "map": chosen.source,
            "changed": sorted(chosen.changes),
            "run": run, "left": left, "absent": sorted(absent),
            "minutes_run": sum(r["minutes"] for r in run),
            "minutes_left": sum(r["minutes"] for r in left),
        }, indent=1))  # fmt: skip
        return 0

    print(describe_source(chosen.source))
    print(f"affected-specs: {chosen.describe_diff()}")
    minutes_run = sum(r["minutes"] for r in run)
    if not run and not left:
        print("affected-specs: the change reaches no spec: nothing to run")
    elif not run:
        cap = counted(args.minutes, "CI minute")
        print(f"affected-specs: the first spec is past the cap of {cap}: nothing to run")
    else:
        verb = "runs" if args.run else "would run"
        print(
            f"{verb} {counted(len(run), 'spec')}, {minutes_run:.1f} CI minutes "
            f"(the cap is {args.minutes:g}; a changed spec runs past it):"
        )
        print_rows(run, absent)
    if left:
        print(
            f"leaves {counted(len(left), 'spec')}, "
            f"{sum(r['minutes'] for r in left):.1f} CI minutes, to CI:"
        )
        print_rows(left, absent)
    if args.run and absent:
        print(
            "left out, not in this worktree (newer on dev than the branch): "
            + ", ".join(sorted(absent))
        )
    if not args.run or not run:
        return 0
    e2e = (chosen.root / E2E).resolve()
    filters = ["/^" + escape(f"{e2e}/{row['spec']}") + "$/" for row in run]
    above = counted(len(run), "spec")
    print(f"affected-specs: npx playwright test <the {above} above>", flush=True)
    return subprocess.run(
        ["npx", "playwright", "test", *filters, *playwright_args], cwd=chosen.root / "front-end"
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
