#!/usr/bin/env bash
#
# The no-mistakes gate's lint step: Prettier, ESLint and Stylelint, as the front end pins them, on
# the files the branch changes since origin/dev (docs/implementation/testing/ci-and-the-gate.md).
#
# Usage:
#     ./scripts/nm-lint.sh --prepare   # npm ci in front-end/, from the machine's npm cache
#     ./scripts/nm-lint.sh             # lint the branch's changed front-end, docs and root Markdown
#
# The gate's run worktree holds tracked files only, so .no-mistakes.yaml's `prepare` runs this with
# --prepare once a run, before its first configured command, and its `lint` runs it without.
#
# Without a switch it takes every file changed since the merge base with origin/dev that is still
# there (committed, staged, edited or new and not ignored) and is not a symlink, and runs from
# front-end/:
#   - Prettier's check, as format:check, on those under front-end/ and docs/ and the Markdown files
#     at the root (a file Prettier has no parser for, or .prettierignore names, is skipped);
#   - ESLint, as lint:check, on those under front-end/ it can read (a file its config ignores is
#     skipped);
#   - Stylelint, as lint:css, on the .css and .vue files under front-end/src/.
# A tool whose config, or the front end's package.json or lockfile, the branch changes runs its
# whole npm script instead, as CI's frontend-lint-and-types does, since the change may reach any
# file. Each tool with files to check runs even after another fails, and the run fails after the
# last when any of them failed.
# This script runs no type-check; CI runs it, and every one of these checks again, on the whole
# front end.
#
# Requires: Node.js 24.22.1 (.nvmrc): the one on PATH, else nvm's, else it fails.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
FRONT_END="$REPO_ROOT/front-end"

fail() { echo "nm-lint: ERROR: $*" >&2; exit 1; }

PREPARE=false
case "${1:-}" in
  "") ;;
  --prepare) PREPARE=true ;;
  *) fail "unknown argument: $1 (usage: nm-lint.sh [--prepare])" ;;
esac

# The pinned Node, from PATH or else from nvm, whose npm is then the pinned npm (engines.npm).
use_pinned_node() {
  local pinned found nvm_bin
  pinned="v$(cat "$REPO_ROOT/.nvmrc")"
  found="$(node --version 2>/dev/null)" || found="no Node"
  [[ "$found" == "$pinned" ]] && return 0
  nvm_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/$pinned/bin"
  [[ -x "$nvm_bin/node" ]] || fail "Node is $found, not $pinned (.nvmrc), and nvm has no $pinned; run nvm install"
  echo "nm-lint: Node on PATH is $found; using nvm's $pinned"
  export PATH="$nvm_bin:$PATH"
}

if [[ "$PREPARE" == true ]]; then
  use_pinned_node
  cd "$FRONT_END"
  npm ci --engine-strict --prefer-offline --no-audit --no-fund
  exit 0
fi

cd "$REPO_ROOT"
BASE="$(git merge-base origin/dev HEAD)"

# The changed files that are still there, each once, in path order.
CHANGED=()
while IFS= read -r -d '' path; do
  CHANGED+=("$path")
done < <(
  {
    git diff -z --name-only --diff-filter=d "$BASE"
    git ls-files -z --others --exclude-standard
  } | sort -zu
)

PRETTIER_FILES=()
ESLINT_FILES=()
STYLELINT_FILES=()
WHOLE_PRETTIER=false
WHOLE_ESLINT=false
WHOLE_STYLELINT=false
for path in ${CHANGED[@]+"${CHANGED[@]}"}; do
  # Prettier refuses a symlink named on its command line, and format:check's globs pass over one.
  [[ -L "$path" ]] && continue
  case "$path" in
    front-end/package.json | front-end/package-lock.json)
      WHOLE_PRETTIER=true WHOLE_ESLINT=true WHOLE_STYLELINT=true ;;
    front-end/.prettierrc.json | front-end/.prettierignore) WHOLE_PRETTIER=true ;;
    front-end/eslint.config.ts) WHOLE_ESLINT=true ;;
    front-end/stylelint.config.js) WHOLE_STYLELINT=true ;;
  esac
  case "$path" in
    docs/*) PRETTIER_FILES+=("../$path") ;;
    front-end/*)
      local_path="${path#front-end/}"
      PRETTIER_FILES+=("$local_path")
      case "$local_path" in
        *.js | *.mjs | *.cjs | *.ts | *.mts | *.cts | *.tsx | *.vue) ESLINT_FILES+=("$local_path") ;;
      esac
      case "$local_path" in
        src/*.css | src/*.vue) STYLELINT_FILES+=("$local_path") ;;
      esac
      ;;
    */*) ;;
    *.md) PRETTIER_FILES+=("../$path") ;;
  esac
done

if [[ ${#PRETTIER_FILES[@]} -eq 0 ]]; then
  echo "nm-lint: no changed front-end, docs or root Markdown file to lint"
  exit 0
fi

[[ -d "$FRONT_END/node_modules" ]] || fail "front-end/node_modules is missing; run scripts/nm-lint.sh --prepare"
use_pinned_node
cd "$FRONT_END"

FAILED=()
# Runs one tool: its whole npm script when the branch changes its config, else the binary the front
# end pins on the files after its flags (the first <flag count> arguments), and nothing when there
# are none; a failure is noted, never fatal.
check() {
  local tool="$1" whole="$2" script="$3" flags="$4"
  shift 4
  if [[ "$whole" == true ]]; then
    echo "nm-lint: $tool: the branch changes its config, so npm run $script"
    npm run "$script" || FAILED+=("$tool")
  elif [[ $# -gt "$flags" ]]; then
    echo "nm-lint: $tool on $(($# - flags)) changed file(s)"
    "./node_modules/.bin/$tool" "$@" || FAILED+=("$tool")
  fi
}

check prettier "$WHOLE_PRETTIER" format:check 4 \
  --config .prettierrc.json --check --ignore-unknown "${PRETTIER_FILES[@]}"
check eslint "$WHOLE_ESLINT" lint:check 3 \
  --max-warnings 0 --no-warn-ignored ${ESLINT_FILES[@]+"${ESLINT_FILES[@]}"}
check stylelint "$WHOLE_STYLELINT" lint:css 3 \
  --max-warnings 0 --allow-empty-input ${STYLELINT_FILES[@]+"${STYLELINT_FILES[@]}"}

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "nm-lint: FAILED: ${FAILED[*]}" >&2
  exit 1
fi
echo "nm-lint: OK"
