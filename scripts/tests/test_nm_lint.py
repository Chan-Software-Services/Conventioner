"""nm-lint.sh, run from a copy of the script in a repository whose front end's tools are fakes that
record how they were called, on a Node of the pinned version or not."""

import os
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
BASH = shutil.which("bash")
PINNED = "24.22.1"
TOOLS = ("prettier", "eslint", "stylelint")


def git(root, *args):
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
        cwd=root,
        check=True,
        capture_output=True,
    )


def executable(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!{BASH}\n" + textwrap.dedent(body))
    path.chmod(0o755)


def fake_node(directory, version, npm_name="npm"):
    """A `node` that prints its version, and an `npm` beside it that records how it was called,
    under `npm_name`, and fails when FAIL_NPM is set."""
    executable(directory / "node", f'[[ "$1" == --version ]] && echo v{version}\n')
    executable(
        directory / "npm",
        f'echo "{npm_name} $* (in $PWD)" >>"$NM_LINT_LOG"\n'
        '[[ -n "${FAIL_NPM:-}" ]] && exit 1\n'
        "exit 0\n",
    )


@pytest.fixture
def repo(tmp_path):
    """A repository holding the script and a front end, whose dev is recorded as origin/dev, with
    fake tools in front-end/node_modules/.bin that log their arguments and directory."""
    root = tmp_path / "repo"
    (root / "scripts").mkdir(parents=True)
    shutil.copy(REPO / "scripts" / "nm-lint.sh", root / "scripts")
    (root / ".nvmrc").write_text(PINNED + "\n")
    (root / "front-end" / "src").mkdir(parents=True)
    (root / "front-end" / "src" / "old.ts").write_text("export const a = 1;\n")
    (root / "front-end" / "eslint.config.ts").write_text("export default [];\n")
    (root / "front-end" / ".gitignore").write_text("node_modules/\n")
    (root / "docs").mkdir()
    (root / "docs" / "old.md").write_text("# Old\n")
    (root / "back-end").mkdir()
    (root / "back-end" / "app.py").write_text("print(1)\n")
    git(root, "init", "-q", "-b", "dev")
    git(root, "add", ".")
    git(root, "commit", "-q", "--no-verify", "-m", "chore: start")
    git(root, "update-ref", "refs/remotes/origin/dev", "HEAD")
    git(root, "switch", "-q", "-c", "feature")
    for tool in TOOLS:
        executable(
            root / "front-end" / "node_modules" / ".bin" / tool,
            f'echo "{tool} $* (in $PWD)" >>"$NM_LINT_LOG"\n'
            f'[[ "${{FAIL_TOOL:-}}" == {tool} ]] && exit 1\n'
            "exit 0\n",
        )
    return root


@pytest.fixture
def run(tmp_path):
    """Runs the script in `root` on a PATH whose `node` is `node_version`, with an nvm directory
    that holds no Node unless a test puts one there; returns the result and the tools' log."""

    def run_script(root, *args, node_version=PINNED, env=None):
        bin_dir = tmp_path / "bin"
        fake_node(bin_dir, node_version)
        log = tmp_path / "tools.log"
        log.write_text("")
        full_env = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "HOME": str(tmp_path / "home"),
            "NVM_DIR": str(tmp_path / "nvm"),
            "NM_LINT_LOG": str(log),
        }
        full_env.update(env or {})
        result = subprocess.run(
            [BASH, str(root / "scripts" / "nm-lint.sh"), *args],
            cwd=root,
            env=full_env,
            capture_output=True,
            text=True,
        )
        return result, log.read_text().splitlines()

    return run_script


def change(root, files, commit=True):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    if commit:
        git(root, "add", ".")
        git(root, "commit", "-q", "--no-verify", "-m", "feat: change")


def test_a_branch_changing_no_front_end_docs_or_root_markdown_file_lints_nothing(repo, run):
    change(repo, {"back-end/app.py": "print(2)\n", "back-end/README.md": "# Back end\n"})

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    assert "nm-lint: no changed front-end, docs or root Markdown file to lint" in result.stdout
    assert log == []


def test_each_tool_checks_only_the_changed_files_it_reads(repo, run):
    git(repo, "rm", "-q", "front-end/src/old.ts")
    change(
        repo,
        {
            "front-end/src/a.ts": "export const b = 2;\n",
            "front-end/src/b.vue": "<template><p /></template>\n",
            "front-end/src/c.css": "p {}\n",
            "front-end/e2e/d.spec.ts": "export {};\n",
            "front-end/public/e.png": "png",
            "docs/old.md": "# Changed\n",
            "back-end/app.py": "print(2)\n",
        },
    )

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    front_end = repo / "front-end"
    assert log == [
        "prettier --config .prettierrc.json --check --ignore-unknown "
        f"../docs/old.md e2e/d.spec.ts public/e.png src/a.ts src/b.vue src/c.css (in {front_end})",
        f"eslint --max-warnings 0 --no-warn-ignored e2e/d.spec.ts src/a.ts src/b.vue (in {front_end})",
        f"stylelint --max-warnings 0 --allow-empty-input src/b.vue src/c.css (in {front_end})",
    ]
    assert "nm-lint: OK" in result.stdout


def test_a_change_not_yet_committed_is_linted_too(repo, run):
    change(repo, {"front-end/src/staged.ts": "export {};\n"}, commit=False)
    git(repo, "add", "front-end/src/staged.ts")
    change(repo, {"front-end/src/untracked.ts": "export {};\n"}, commit=False)

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    assert log[1] == (
        "eslint --max-warnings 0 --no-warn-ignored src/staged.ts src/untracked.ts "
        f"(in {repo / 'front-end'})"
    )


@pytest.mark.parametrize(
    "config, whole",
    [
        ("front-end/.prettierrc.json", ["prettier"]),
        ("front-end/eslint.config.ts", ["eslint"]),
        ("front-end/stylelint.config.js", ["stylelint"]),
        ("front-end/package-lock.json", ["prettier", "eslint", "stylelint"]),
    ],
)
def test_a_changed_config_has_its_tool_check_everything_as_ci_does(repo, run, config, whole):
    change(repo, {config: "{}\n", "front-end/src/a.vue": "<template><p /></template>\n"})

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    npm_runs = [line for line in log if line.startswith("npm ")]
    expected = {"prettier": "format:check", "eslint": "lint:check", "stylelint": "lint:css"}
    assert npm_runs == [
        f"npm run {expected[tool]} (in {repo / 'front-end'})" for tool in TOOLS if tool in whole
    ]
    for tool in TOOLS:
        if tool not in whole:
            assert any(line.startswith(f"{tool} ") for line in log)


def test_a_failing_tool_fails_the_run_after_every_tool_has_run(repo, run):
    change(repo, {"front-end/src/a.vue": "<template><p /></template>\n"})

    result, log = run(repo, env={"FAIL_TOOL": "prettier"})

    assert result.returncode == 1
    assert [line.split()[0] for line in log] == list(TOOLS)
    assert "nm-lint: FAILED: prettier" in result.stderr


def test_without_the_front_ends_dependencies_it_says_to_prepare(repo, run):
    shutil.rmtree(repo / "front-end" / "node_modules")
    change(repo, {"front-end/src/a.ts": "export {};\n"})

    result, _ = run(repo)

    assert result.returncode == 1
    assert "front-end/node_modules is missing; run scripts/nm-lint.sh --prepare" in result.stderr


def test_prepare_installs_the_locked_dependencies_from_the_cache(repo, run):
    result, log = run(repo, "--prepare")

    assert result.returncode == 0, result.stderr
    assert log == [
        "npm ci --engine-strict --prefer-offline --no-audit --no-fund "
        f"(in {repo / 'front-end'})"
    ]


def test_a_node_off_the_pin_is_replaced_by_nvms_pinned_one(repo, run, tmp_path):
    fake_node(tmp_path / "nvm" / "versions" / "node" / f"v{PINNED}" / "bin", PINNED, "nvm-npm")

    result, log = run(repo, "--prepare", node_version="22.1.0")

    assert result.returncode == 0, result.stderr
    assert f"nm-lint: Node on PATH is v22.1.0; using nvm's v{PINNED}" in result.stdout
    assert log == [
        "nvm-npm ci --engine-strict --prefer-offline --no-audit --no-fund "
        f"(in {repo / 'front-end'})"
    ]


def test_the_tools_run_on_nvms_pinned_node_when_the_one_on_path_is_off_the_pin(repo, run, tmp_path):
    nvm_bin = tmp_path / "nvm" / "versions" / "node" / f"v{PINNED}" / "bin"
    fake_node(nvm_bin, PINNED)
    executable(
        repo / "front-end" / "node_modules" / ".bin" / "prettier",
        'echo "prettier on $(command -v node)" >>"$NM_LINT_LOG"\n',
    )
    change(repo, {"docs/old.md": "# Changed\n"})

    result, log = run(repo, node_version="22.1.0")

    assert result.returncode == 0, result.stderr
    assert log == [f"prettier on {nvm_bin / 'node'}"]


def test_a_branch_changing_docs_alone_runs_prettier_alone(repo, run):
    change(repo, {"docs/old.md": "# Changed\n", "docs/new.md": "# New\n"})

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    assert log == [
        "prettier --config .prettierrc.json --check --ignore-unknown ../docs/new.md ../docs/old.md "
        f"(in {repo / 'front-end'})"
    ]


def test_a_branch_changing_root_markdown_runs_prettier_on_it_as_format_check_does(repo, run):
    change(repo, {"README.md": "# Readme\n", "back-end/README.md": "# Back end\n"})

    result, log = run(repo)

    assert result.returncode == 0, result.stderr
    assert log == [
        "prettier --config .prettierrc.json --check --ignore-unknown ../README.md "
        f"(in {repo / 'front-end'})"
    ]


def test_a_failing_whole_script_fails_the_run(repo, run):
    change(repo, {"front-end/eslint.config.ts": "export default [{}];\n"})

    result, log = run(repo, env={"FAIL_NPM": "1"})

    assert result.returncode == 1
    assert f"npm run lint:check (in {repo / 'front-end'})" in log
    assert "nm-lint: FAILED: eslint" in result.stderr


def test_a_failing_install_fails_prepare(repo, run):
    result, log = run(repo, "--prepare", env={"FAIL_NPM": "1"})

    assert result.returncode != 0
    assert len(log) == 1 and log[0].startswith("npm ci ")


def test_a_node_off_the_pin_with_no_pinned_one_in_nvm_fails_loud(repo, run):
    result, log = run(repo, "--prepare", node_version="22.1.0")

    assert result.returncode == 1
    assert (
        f"nm-lint: ERROR: Node is v22.1.0, not v{PINNED} (.nvmrc), and nvm has no v{PINNED}; "
        "run nvm install"
    ) in result.stderr
    assert log == []
