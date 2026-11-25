"""The E2E specs a builder runs (T349): `scripts/affected-specs.py` reads the test map and a diff,
and chooses the spec files the change reaches, in order, up to a cap of CI minutes.

Each test makes a small repository with a spec or three, a helper, front-end modules and a back
end, commits a base with an `origin/dev` ref at it, changes it, and reads what the selector
chooses from a fixture map, by its command line as a builder runs it.
"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "affected-specs.py"

spec = importlib.util.spec_from_file_location("affected_specs", SCRIPT)
affected_specs = importlib.util.module_from_spec(spec)
sys.modules["affected_specs"] = affected_specs
spec.loader.exec_module(affected_specs)

DOOR_PY = textwrap.dedent(
    '''\
    import json

    LIMIT = 3


    def door(market):
        def inner(row):
            return row["name"]

        return [inner(r) for r in market]


    def check_in(vendor):
        vendor["here"] = True
        return vendor
    '''
)

MARKETS_PY = textwrap.dedent(
    '''\
    def list_markets():
        return []


    def load(market_id):
        return {"id": market_id}
    '''
)

# a.spec reaches the door; b.spec checks in; c.spec reads the stats. All three load the app shell
# and list the markets, as every real spec does.
MAP = {
    "commit": "f00dfeed",
    "specs": {
        "a.spec.ts": {
            "modules": ["front-end/src/App.vue", "front-end/src/views/Door.vue"],
            "endpoints": ["GET /door", "GET /markets"],
        },
        "b.spec.ts": {
            "modules": ["front-end/src/App.vue"],
            "endpoints": ["GET /markets", "POST /checkin"],
        },
        "c.spec.ts": {
            "modules": ["front-end/src/App.vue", "front-end/src/views/Stats.vue"],
            "endpoints": ["GET /markets", "GET /stats"],
        },
    },
    "endpoints": {
        "GET /markets": {"back-end/api/markets.py": ["list_markets", "load"]},
        "GET /door": {"back-end/api/door.py": ["door", "door.inner"]},
        "POST /checkin": {"back-end/api/door.py": ["check_in"]},
        "GET /stats": {"back-end/api/stats.py": ["stats"]},
    },
}

BASE_FILES = {
    "front-end/e2e/a.spec.ts": "import { test } from './fixtures';\nimport { seat } from './helpers/seat';\n",
    "front-end/e2e/b.spec.ts": "import { test } from './fixtures';\n",
    "front-end/e2e/c.spec.ts": "import { test } from './fixtures';\n",
    "front-end/e2e/fixtures.ts": "export const test = 1;\n",
    # a.spec imports seat, which imports the market seed: a helper two levels deep.
    "front-end/e2e/helpers/seat.ts": "import { seedMarket } from './seeds';\nexport const seat = 1;\n",
    "front-end/e2e/helpers/seeds.ts": "export const seedMarket = 1;\n",
    "front-end/playwright.config.ts": "export default {};\n",
    "front-end/src/App.vue": "<template><div /></template>\n",
    "front-end/src/views/Door.vue": "<template><div /></template>\n",
    "front-end/src/views/Stats.vue": "<template><div /></template>\n",
    "back-end/api/door.py": DOOR_PY,
    "back-end/api/markets.py": MARKETS_PY,
    "back-end/api/stats.py": "def stats():\n    return 1\n",
    # Files no rule places: no spec imports them, no page loaded them, no endpoint ran them.
    "front-end/src/assets/old.css": "p { margin: 0; }\n",
    "front-end/tools/old-tool.ts": "export const tool = 1;\n",
    "back-end/utils/old_module.py": "def old():\n    return 1\n",
}


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout


def write(repo, files):
    for path, text in files.items():
        target = repo / path
        if text is None:
            target.unlink()
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)


@pytest.fixture
def repo(tmp_path):
    """A repository at its base, `origin/dev` there, with the fixture map beside it."""
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "dev")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "config", "user.name", "Fixture")
    git(root, "config", "commit.gpgsign", "false")
    write(root, BASE_FILES)
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "base")
    git(root, "update-ref", "refs/remotes/origin/dev", "HEAD")
    git(root, "switch", "-q", "-c", "work")
    (tmp_path / "test-map.json").write_text(json.dumps(MAP))
    return root


def seconds_file(tmp_path, seconds):
    """A shard-results directory, laid out as `gh run download` lays out the e2e-results artifacts,
    one report a shard, each spec's tests summed across them."""
    results = tmp_path / "results"
    for n, (spec_file, total) in enumerate(seconds.items(), start=1):
        shard = results / f"e2e-results-shard-{n}"
        shard.mkdir(parents=True)
        report = {
            "suites": [
                {
                    "file": spec_file,
                    "specs": [{"tests": [{"results": [{"duration": total * 1000}]}]}],
                }
            ]
        }
        (shard / "results.json").write_text(json.dumps(report))
    return results


def choose(repo, *args, env=None, fixture_map=True):
    """The selector's --list --json, from the repository, with the fixture map unless told not to,
    when it finds the map itself."""
    command = [sys.executable, str(SCRIPT), "--list", "--json", *args]
    if fixture_map:
        command += ["--map", str(repo.parent / "test-map.json")]
    done = subprocess.run(
        command, cwd=repo, capture_output=True, text=True, env={**os.environ, **(env or {})}
    )
    assert done.returncode == 0, done.stdout + done.stderr
    return json.loads(done.stdout)


def chosen(result):
    return {row["spec"]: row for row in result["run"] + result["left"]}


class TestRuleOneChangedSpecsAndHelpers:
    def test_a_changed_spec_is_chosen_and_scores_one(self, repo):
        write(repo, {"front-end/e2e/c.spec.ts": "import { test } from './fixtures';\n// more\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"c.spec.ts"}
        assert rows["c.spec.ts"]["score"] == 1
        assert rows["c.spec.ts"]["changed"] is True
        assert rows["c.spec.ts"]["why"] == ["changed spec"]

    def test_a_helper_two_levels_deep_reaches_the_spec_importing_it(self, repo):
        write(repo, {"front-end/e2e/helpers/seeds.ts": "export const seedMarket = 2;\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts"}
        assert rows["a.spec.ts"]["score"] == 1
        assert rows["a.spec.ts"]["changed"] is False
        assert rows["a.spec.ts"]["why"] == ["imports helpers/seeds.ts"]

    def test_a_spec_the_change_deletes_is_not_chosen(self, repo):
        write(repo, {"front-end/e2e/c.spec.ts": None})
        assert chosen(choose(repo)) == {}

    def test_uncommitted_and_untracked_changes_count(self, repo):
        write(repo, {"front-end/e2e/b.spec.ts": "import { test } from './fixtures';\n// edit\n"})
        write(repo, {"front-end/e2e/d.spec.ts": "import { test } from './fixtures';\n"})
        assert set(chosen(choose(repo))) == {"b.spec.ts", "d.spec.ts"}

    def test_at_a_commit_an_import_names_the_file_beside_a_directory_of_its_name(self, repo):
        # `e2e/fixtures/` holds data files beside `e2e/fixtures.ts`; read from a commit, as CI's
        # audit reads with `--head`, `./fixtures` is the file, never the directory.
        write(repo, {"front-end/e2e/fixtures/data.json": "{}\n"})
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "a directory named as the fixtures")
        git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
        write(repo, {"front-end/e2e/fixtures.ts": "export const test = 2;\n"})
        git(repo, "commit", "-qam", "the fixtures change")
        rows = chosen(choose(repo, "--head", "HEAD"))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert "imports fixtures.ts" in rows["b.spec.ts"]["why"]

    def test_committed_changes_count_from_the_merge_base(self, repo):
        write(repo, {"front-end/e2e/b.spec.ts": "// edit\n"})
        git(repo, "commit", "-qam", "edit b")
        # dev moves on after the branch forked: its own change is not the branch's.
        git(repo, "switch", "-q", "dev")
        write(repo, {"front-end/e2e/c.spec.ts": "// dev's edit\n"})
        git(repo, "commit", "-qam", "edit c on dev")
        git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
        git(repo, "switch", "-q", "work")
        assert set(chosen(choose(repo))) == {"b.spec.ts"}


class TestRuleTwoFrontEndModules:
    def test_a_module_one_spec_loads_scores_one(self, repo):
        write(repo, {"front-end/src/views/Door.vue": "<template><p /></template>\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts"}
        assert rows["a.spec.ts"]["score"] == 1
        assert rows["a.spec.ts"]["why"] == ["loads front-end/src/views/Door.vue (1/1)"]

    def test_a_module_every_spec_loads_scores_little(self, repo):
        write(repo, {"front-end/src/App.vue": "<template><p /></template>\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert [row["score"] for row in rows.values()] == [pytest.approx(1 / 3)] * 3

    def test_a_unit_test_under_src_reaches_no_spec(self, repo):
        write(repo, {"front-end/src/__tests__/Door.test.ts": "// a unit test\n"})
        assert chosen(choose(repo)) == {}


class TestRuleThreeBackEndFunctions:
    def test_a_changed_function_reaches_the_specs_calling_its_endpoints(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY.replace("= True", "= 'yes'")})
        rows = chosen(choose(repo))
        assert set(rows) == {"b.spec.ts"}
        assert rows["b.spec.ts"]["score"] == 1
        assert rows["b.spec.ts"]["why"] == ["back-end/api/door.py:check_in via POST /checkin (1/1)"]

    def test_a_nested_function_is_named_as_the_map_names_it(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY.replace('row["name"]', 'row["id"]')})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts"}
        assert rows["a.spec.ts"]["why"] == ["back-end/api/door.py:door.inner via GET /door (1/1)"]

    def test_a_changed_line_that_reads_as_a_diff_header_keeps_the_later_hunks(self, repo):
        # Added, `++ one more` reads `+++ one more` in the diff, as a file's header does.
        noted = DOOR_PY.replace(
            "    return [inner(r)", '    note = """\n++ one more\n"""\n    return [inner(r)'
        )
        write(repo, {"back-end/api/door.py": noted.replace("= True", "= 'yes'")})
        rows = chosen(choose(repo))
        assert {spec: row["score"] for spec, row in rows.items()} == {
            "a.spec.ts": 1,
            "b.spec.ts": 1,
        }

    def test_a_deleted_function_is_found_by_its_old_name(self, repo):
        without = DOOR_PY[: DOOR_PY.index("\n\ndef check_in")] + "\n"
        write(repo, {"back-end/api/door.py": without})
        rows = chosen(choose(repo))
        assert set(rows) == {"b.spec.ts"}
        assert rows["b.spec.ts"]["why"] == ["back-end/api/door.py:check_in via POST /checkin (1/1)"]

    def test_a_deleted_file_is_found_by_its_old_functions(self, repo):
        write(repo, {"back-end/api/stats.py": None})
        rows = chosen(choose(repo))
        assert set(rows) == {"c.spec.ts"}
        assert rows["c.spec.ts"]["score"] == 1

    def test_a_change_outside_any_function_selects_its_files_specs_and_scores_nothing(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY.replace("LIMIT = 3", "LIMIT = 4")})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts"}
        assert {row["score"] for row in rows.values()} == {0}
        assert rows["b.spec.ts"]["why"] == ["back-end/api/door.py, outside any function the map knows"]

    def test_a_blank_or_comment_line_between_functions_reaches_nothing(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY.replace("\n\ndef check_in", "\n# the door\n\n\ndef check_in")})
        assert chosen(choose(repo)) == {}

    def test_a_function_the_map_does_not_know_counts_for_every_function_of_its_file(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY + "\n\ndef helper():\n    return 2\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts"}
        assert {row["score"] for row in rows.values()} == {0}

    def test_a_change_with_no_lines_counts_for_every_function_of_its_file(self, repo):
        (repo / "back-end/api/door.py").chmod(0o755)
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts"}

    def test_a_hash_line_inside_a_string_is_code(self, repo):
        quoted = DOOR_PY.replace(
            'vendor["here"] = True', 'vendor["here"] = """\n# yes\n"""'
        )
        base(repo, {"back-end/api/door.py": quoted})
        write(repo, {"back-end/api/door.py": quoted.replace("# yes", "# no")})
        assert set(chosen(choose(repo))) == {"b.spec.ts"}

    def test_the_back_ends_tests_reach_no_spec(self, repo):
        write(repo, {"back-end/tests/test_door.py": "def test_door():\n    assert True\n"})
        assert chosen(choose(repo)) == {}


DOCUMENTED_PY = '"""The door.\n\nIt lets vendors in.\n"""\n' + DOOR_PY.replace(
    "def check_in(vendor):\n",
    'def check_in(vendor):\n    """Mark the vendor here.\n\n    Once a day.\n    """\n',
)


def base(repo, files):
    """Move the base, and `origin/dev` with it, to the fixture's files with these."""
    write(repo, files)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "a new base")
    git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")


class TestWordsOnly:
    """A change to words alone, a docstring's or a comment's, changes nothing that runs, so it
    chooses no spec; a change beside it to what runs still chooses as before."""

    @pytest.fixture
    def documented(self, repo):
        base(repo, {"back-end/api/door.py": DOCUMENTED_PY})
        return repo

    def test_a_module_docstring_chooses_nothing(self, documented):
        write(documented, {"back-end/api/door.py": DOCUMENTED_PY.replace("lets vendors", "lets every vendor")})
        assert chosen(choose(documented)) == {}

    def test_a_function_docstring_chooses_nothing(self, documented):
        write(documented, {"back-end/api/door.py": DOCUMENTED_PY.replace("Once a day.", "Once a day,\n    or twice.")})
        assert chosen(choose(documented)) == {}

    def test_a_docstring_added_or_removed_chooses_nothing(self, repo):
        write(repo, {"back-end/api/door.py": DOCUMENTED_PY})
        assert chosen(choose(repo)) == {}

    def test_code_beside_a_docstring_still_chooses_its_function(self, documented):
        changed = DOCUMENTED_PY.replace("Once a day.", "Twice a day.").replace("= True", "= 'yes'")
        write(documented, {"back-end/api/door.py": changed.replace("lets vendors", "lets every vendor")})
        rows = chosen(choose(documented))
        assert set(rows) == {"b.spec.ts"}
        assert rows["b.spec.ts"]["why"] == ["back-end/api/door.py:check_in via POST /checkin (1/1)"]

    def test_a_comment_line_inside_a_function_chooses_nothing(self, repo):
        write(repo, {"back-end/api/door.py": DOOR_PY.replace('    vendor["here"]', '    # here\n    vendor["here"]')})
        assert chosen(choose(repo)) == {}

    def test_code_on_a_line_with_a_comment_still_chooses_its_function(self, repo):
        commented = DOOR_PY.replace("= True", "= True  # here")
        base(repo, {"back-end/api/door.py": commented})
        write(repo, {"back-end/api/door.py": commented.replace("= True", "= 'yes'")})
        rows = chosen(choose(repo))
        assert set(rows) == {"b.spec.ts"}
        assert rows["b.spec.ts"]["why"] == ["back-end/api/door.py:check_in via POST /checkin (1/1)"]

    def test_a_string_that_does_not_open_its_body_is_code(self, repo):
        loose = DOOR_PY.replace("LIMIT = 3\n", 'LIMIT = 3\n"""A note."""\n')
        base(repo, {"back-end/api/door.py": loose})
        write(repo, {"back-end/api/door.py": loose.replace("A note", "Another note")})
        assert set(chosen(choose(repo))) == {"a.spec.ts", "b.spec.ts"}

    def test_a_docstring_that_swallows_code_is_code(self, repo):
        # The docstring's quotes move so that it holds `LIMIT = 3`, a line the change leaves.
        base(repo, {"back-end/api/door.py": '"""The door."""\n' + DOOR_PY.replace("LIMIT = 3\n", "LIMIT = 3\n# the end\n")})
        write(repo, {"back-end/api/door.py": '"""The door.\n' + DOOR_PY.replace("LIMIT = 3\n", 'LIMIT = 3\n# the end"""\n')})
        assert set(chosen(choose(repo))) == {"a.spec.ts", "b.spec.ts"}

    def test_a_file_that_does_not_parse_counts_its_docstring(self, repo):
        broken = DOCUMENTED_PY + "\ndef (:\n"
        base(repo, {"back-end/api/door.py": broken})
        write(repo, {"back-end/api/door.py": broken.replace("lets vendors", "lets every vendor")})
        assert set(chosen(choose(repo))) == {"a.spec.ts", "b.spec.ts"}

    def test_a_docstring_removed_from_a_file_it_breaks_is_code(self, repo):
        # The class's only body is its docstring, so the head left without it does not parse.
        gone = DOOR_PY + '\n\nclass Gone(Exception):\n    """Gone."""\n'
        base(repo, {"back-end/api/door.py": gone})
        write(repo, {"back-end/api/door.py": gone.replace('    """Gone."""\n', "")})
        assert set(chosen(choose(repo))) == {"a.spec.ts", "b.spec.ts"}

    SCRIPT_TS = textwrap.dedent(
        """\
        // The door's rows.
        /* Each row
         * is a vendor. */
        export const door = (rows: string[]) => rows.map((r) => r.trim()) // trimmed
        export const path = /\\/door\\/*/g
        export const note = '// not a comment' + `/* nor ${'this'} */`
        """
    )
    DOOR_VUE = textwrap.dedent(
        """\
        <script setup lang="ts">
        // The door.
        const rows = ['a'] /* one row */
        </script>

        <template>
          <!-- Each vendor at the door. -->
          <p title="<!-- kept -->">{{ rows.join('<!--') }}</p>
        </template>
        """
    )

    @pytest.fixture
    def scripted(self, repo):
        base(repo, {"front-end/src/views/Door.vue": self.DOOR_VUE, "front-end/src/door.ts": self.SCRIPT_TS})
        mapped = json.loads((repo.parent / "test-map.json").read_text())
        mapped["specs"]["a.spec.ts"]["modules"].append("front-end/src/door.ts")
        (repo.parent / "test-map.json").write_text(json.dumps(mapped))
        return repo

    @pytest.mark.parametrize(
        "old, new",
        [
            ("// The door's rows.", "// The rows at the door."),
            ("// The door's rows.\n", ""),
            ("is a vendor. */", "is a vendor,\n * or a helper. */"),
            ("// trimmed", "// trimmed\n// and mapped"),
            ("rows.map((r) => r.trim())", "rows.map((r) => r.trim()) /* each */"),
        ],
    )
    def test_a_script_comment_chooses_nothing(self, scripted, old, new):
        assert old in self.SCRIPT_TS
        write(scripted, {"front-end/src/door.ts": self.SCRIPT_TS.replace(old, new)})
        assert chosen(choose(scripted)) == {}

    @pytest.mark.parametrize(
        "old, new",
        [
            ("r.trim()", "r.trimEnd()"),
            # Words in a string, a template or a regex that look like a comment are code.
            ("'// not a comment'", "'// not a comment, still'"),
            ("/* nor ${'this'} */", "/* nor ${'that'} */"),
            ("\\/door\\/*/g", "\\/door\\/*/gi"),
            # A comment that opens over code takes the code out.
            ("/* Each row", "/* Each row */ export const x = 1 /*"),
            ("export const path", "// export const path"),
        ],
    )
    def test_code_in_a_script_still_chooses_its_specs(self, scripted, old, new):
        assert old in self.SCRIPT_TS
        write(scripted, {"front-end/src/door.ts": self.SCRIPT_TS.replace(old, new)})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    def test_a_comment_that_opens_over_unchanged_code_is_code(self, scripted):
        # `/*` and `*/` added on lines of their own take out the line between, which the change
        # leaves alone.
        text = self.SCRIPT_TS.replace("export const door", "/*\nexport const door").replace(
            "export const path", "*/\nexport const path"
        )
        write(scripted, {"front-end/src/door.ts": text})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    @pytest.mark.parametrize(
        "unclosed",
        ["'a string", "`a template", "/* a comment", "/a regex"],
    )
    def test_a_script_that_does_not_scan_counts_its_comments(self, scripted, unclosed):
        broken = self.SCRIPT_TS + f"export const open = {unclosed}\n"
        base(scripted, {"front-end/src/door.ts": broken})
        write(scripted, {"front-end/src/door.ts": broken.replace("// trimmed", "// trimmed rows")})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    @pytest.mark.parametrize(
        "old, new",
        [
            ("// The door.", "// The door's rows."),
            ("/* one row */", "/* a row */"),
            ("<!-- Each vendor at the door. -->", "<!-- Each vendor\n       at the door. -->"),
            ("  <!-- Each vendor at the door. -->\n", ""),
        ],
    )
    def test_a_vue_comment_chooses_nothing(self, scripted, old, new):
        assert old in self.DOOR_VUE
        write(scripted, {"front-end/src/views/Door.vue": self.DOOR_VUE.replace(old, new)})
        assert chosen(choose(scripted)) == {}

    @pytest.mark.parametrize(
        "old, new",
        [
            ("['a']", "['b']"),
            ('"<!-- kept -->"', '"<!-- changed -->"'),
            ("join('<!--')", "join('<!-- -->')"),
            ("<p title", "<span /><p title"),
            ("<!-- Each vendor at the door. -->", "<!-- Each vendor --> at the door."),
        ],
    )
    def test_code_in_a_vue_file_still_chooses_its_specs(self, scripted, old, new):
        assert old in self.DOOR_VUE
        write(scripted, {"front-end/src/views/Door.vue": self.DOOR_VUE.replace(old, new)})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    @pytest.mark.parametrize(
        "between",
        ["<b>x</b> <!-- c --> <i>y</i>", "<b>x</b> <!-- c --><i>y</i>", "<b>x</b><!-- c --> <i>y</i>"],
    )
    def test_a_template_comment_inline_between_elements_is_code(self, scripted, between):
        # Vue's dev build keeps the comment, and drops the white space between it and an element,
        # so `x y` without it renders `xy` with it.
        inline = self.DOOR_VUE.replace("<p title", between + "<p title")
        base(scripted, {"front-end/src/views/Door.vue": inline})
        write(scripted, {"front-end/src/views/Door.vue": inline.replace(between, "<b>x</b> <i>y</i>")})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    @pytest.mark.parametrize(
        "old, new",
        [
            ('<script setup lang="ts">', '<script setup lang="tsx">'),
            ("<template>", '<template lang="pug">'),
            ("</template>\n", '</template>\n<p title="an unclosed tag"\n'),
        ],
    )
    def test_a_vue_file_it_cannot_read_counts_its_comments(self, scripted, old, new):
        unread = self.DOOR_VUE.replace(old, new)
        base(scripted, {"front-end/src/views/Door.vue": unread})
        write(scripted, {"front-end/src/views/Door.vue": unread.replace("// The door.", "// The door's rows.")})
        assert set(chosen(choose(scripted))) == {"a.spec.ts"}

    def test_a_comment_in_an_e2e_helper_still_chooses_its_specs(self, repo):
        write(repo, {"front-end/e2e/helpers/seeds.ts": "export const seedMarket = 1;\n// the seed\n"})
        assert set(chosen(choose(repo))) == {"a.spec.ts"}


class TestRuleFourEverySpec:
    @pytest.mark.parametrize(
        "path",
        [
            "front-end/playwright.config.ts",
            "front-end/e2e/global-setup.ts",
            "front-end/package-lock.json",
            "front-end/vite.config.ts",
            "front-end/index.html",
            "docker-compose.worktree.yml",
            "back-end/Dockerfile",
            "back-end/requirements-dev.txt",
            "scripts/seed_fixture.sh",
            "scripts/lib/stack-identity.sh",
        ],
    )
    def test_a_file_the_suite_stands_on_chooses_every_spec(self, repo, path):
        write(repo, {path: "changed\n"})
        # e.spec.ts is newer than the map: the tree's specs are chosen too.
        write(repo, {"front-end/e2e/e.spec.ts": "import { test } from './fixtures';\n"})
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "e.spec.ts and the change")
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts", "e.spec.ts"}
        assert rows["a.spec.ts"]["why"] == [f"{path} runs every spec"]

    def test_the_fixtures_are_a_helper_every_spec_imports(self, repo):
        write(repo, {"front-end/e2e/fixtures.ts": "export const test = 2;\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert {row["score"] for row in rows.values()} == {1}

    @pytest.mark.parametrize(
        "path",
        [
            ".github/workflows/test.yml",
            ".github/actions/e2e-stack/action.yml",
            "front-end/scripts/e2e-shards.ts",
            "front-end/scripts/e2e-shard-timings.json",
            "scripts/affected-specs.py",
            "scripts/test_map.py",
            "scripts/chromium-packages.sh",
            "scripts/image-tags.sh",
        ],
    )
    def test_the_e2e_runs_own_machinery_chooses_every_spec_and_scores_nothing(self, repo, path):
        write(repo, {path: "changed\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        for row in rows.values():
            assert row["why"] == [f"{path} runs every spec"]
            assert row["score"] == 0


class TestAFileNoRulePlaces:
    """A changed file the map and the imports cannot place may drive any spec: a stylesheet Vite
    inlines, a back-end module no endpoint ran, a file no rule reads."""

    @pytest.mark.parametrize(
        "path",
        [
            "front-end/src/assets/base.css",
            "back-end/utils/new_module.py",
            "back-end/docker-entrypoint.sh",
            "front-end/tsconfig.app.json",
            # `vite.config.ts` reads its headers, at every config load, the dev server's included.
            "front-end/vercel.json",
        ],
    )
    def test_it_chooses_every_spec_and_scores_nothing(self, repo, path):
        write(repo, {path: "changed\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert {row["score"] for row in rows.values()} == {0}
        assert rows["a.spec.ts"]["why"] == [f"{path} is not in the map"]

    # Git quotes a name holding a quote even where it leaves other names alone.
    @pytest.mark.parametrize("committed", [False, True])
    def test_a_name_git_quotes_is_read_as_it_is(self, repo, committed):
        path = 'front-end/src/assets/a"quote.css'
        write(repo, {path: "changed\n"})
        head = []
        if committed:
            git(repo, "add", "-A")
            git(repo, "commit", "-qm", "the change")
            head = ["--head", "HEAD"]
        result = choose(repo, *head)
        assert result["changed"] == [path]
        assert set(chosen(result)) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert chosen(result)["a.spec.ts"]["why"] == [f"{path} is not in the map"]

    @pytest.mark.parametrize(
        "path",
        [
            "docs/x.md",
            "front-end/README.md",
            "back-end/tests/test_door.py",
            "front-end/src/__tests__/Door.test.ts",
            "front-end/src/utils/door.test.ts",
            "scripts/tests/test_x.py",
            # The unit suite's own files and config, which Vitest alone reads.
            "front-end/src/utils/door.spec.ts",
            "front-end/src/components/Door.test.tsx",
            "front-end/vitest.config.ts",
            "front-end/tsconfig.vitest.json",
            # The lint and format configs, the back end's pytest config.
            "front-end/eslint.config.ts",
            "front-end/stylelint.config.js",
            "front-end/.prettierrc.json",
            "front-end/.prettierignore",
            "front-end/.editorconfig",
            "back-end/pytest.ini",
            # The front end's scripts that check the build or write DESIGN.md, or that nothing in
            # CI runs.
            "front-end/scripts/bundle-budget.ts",
            "front-end/scripts/no-eval.ts",
            "front-end/scripts/brand-icons.ts",
            "front-end/scripts/design-md.ts",
            "front-end/scripts/design-md-content.ts",
            # It decides a push's and the nightly run's suite, never a pull request's E2E.
            "scripts/ci_suite.py",
            # The back end's deploy config, which the stack does not read.
            "back-end/vercel.json",
            # The advisory scan's lock, which only CI's python-advisories job installs.
            "back-end/requirements-audit.in",
            "back-end/requirements-audit.txt",
            # The migrations, which an operator runs by hand and nothing the stack loads imports.
            "back-end/migrations/migrate_door.py",
        ],
    )
    def test_docs_and_the_suites_that_are_not_e2e_choose_nothing(self, repo, path):
        write(repo, {path: "changed\n"})
        assert chosen(choose(repo)) == {}

    def test_a_file_the_map_places_chooses_only_its_specs(self, repo):
        # door.py is in the map, so a comment in it chooses nothing, never every spec.
        write(repo, {"back-end/api/door.py": DOOR_PY.replace("\n\ndef check_in", "\n# the door\n\n\ndef check_in")})
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        assert set(chosen(choose(repo))) == {"a.spec.ts"}

    def test_a_helper_the_change_deletes_is_placed_by_the_base_imports(self, repo):
        write(repo, {
            "front-end/e2e/helpers/seat.ts": "export const seat = 1;\n",
            "front-end/e2e/helpers/seeds.ts": None,
        })  # fmt: skip
        assert set(chosen(choose(repo))) == {"a.spec.ts"}

    def test_with_no_map_the_rule_is_not_applied(self, repo, tmp_path):
        env = TestWhereTheMapComesFrom().fake_gh(tmp_path, "import sys\nsys.exit(1)\n")
        write(repo, {"front-end/src/assets/base.css": "changed\n"})
        assert chosen(choose(repo, env=env, fixture_map=False)) == {}


class TestAFileTheChangeDeletes:
    """A deleted file is placed by its deletion: what read it changes with it, and is placed on its
    own, so a deleted file no spec reached drives none, and one a spec reached drives that spec."""

    UNPLACED = ["front-end/src/assets/old.css", "front-end/tools/old-tool.ts", "back-end/utils/old_module.py"]

    @pytest.mark.parametrize("path", UNPLACED)
    def test_a_deleted_file_no_spec_reached_chooses_nothing(self, repo, path):
        write(repo, {path: None})
        assert chosen(choose(repo)) == {}

    @pytest.mark.parametrize("path", UNPLACED)
    def test_a_committed_deletion_chooses_nothing_either(self, repo, path):
        git(repo, "rm", "-q", path)
        git(repo, "commit", "-qm", "delete it")
        assert chosen(choose(repo, "--head", "HEAD")) == {}

    def test_a_file_no_rule_places_beside_a_deletion_still_chooses_every_spec(self, repo):
        write(repo, {"front-end/src/assets/old.css": None, "front-end/src/assets/base.css": "new\n"})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts", "b.spec.ts", "c.spec.ts"}
        assert rows["a.spec.ts"]["why"] == ["front-end/src/assets/base.css is not in the map"]

    def test_a_deleted_helper_a_spec_imported_still_chooses_that_spec(self, repo):
        # seat.ts still imports the deleted seeds: the spec that imported it at the base breaks.
        write(repo, {"front-end/e2e/helpers/seeds.ts": None})
        rows = chosen(choose(repo))
        assert set(rows) == {"a.spec.ts"}
        assert rows["a.spec.ts"]["why"] == ["imported helpers/seeds.ts, which the change deletes"]
        assert rows["a.spec.ts"]["score"] == 1

    def test_a_deleted_module_a_page_loaded_still_chooses_its_specs(self, repo):
        write(repo, {"front-end/src/views/Door.vue": None})
        assert set(chosen(choose(repo))) == {"a.spec.ts"}


class TestTheOrderAndTheCap:
    def test_specs_run_by_score_then_the_shorter_first(self, repo, tmp_path):
        # App.vue gives each spec 1/3; Door.vue gives a.spec 1 more. b and c tie: c is shorter.
        write(repo, {"front-end/src/App.vue": "<p />\n", "front-end/src/views/Door.vue": "<p />\n"})
        results = seconds_file(tmp_path, {"a.spec.ts": 300, "b.spec.ts": 120, "c.spec.ts": 60})
        result = choose(repo, "--results", str(results))
        assert [row["spec"] for row in result["run"]] == ["a.spec.ts", "c.spec.ts", "b.spec.ts"]
        assert [row["minutes"] for row in result["run"]] == [5, 1, 2]

    def test_the_cap_leaves_the_rest_to_ci_but_never_a_changed_spec(self, repo, tmp_path):
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})  # a.spec: 1
        write(repo, {"front-end/src/App.vue": "<p />\n"})  # each: 1/3
        write(repo, {"front-end/e2e/c.spec.ts": "// edit\n"})  # c.spec: 1 more, changed
        results = seconds_file(tmp_path, {"a.spec.ts": 20 * 60, "b.spec.ts": 5 * 60, "c.spec.ts": 40 * 60})
        result = choose(repo, "--results", str(results), "--minutes", "30")
        # a.spec (4/3, 20 minutes), then c.spec (4/3, 40 minutes, changed: past the cap, it runs
        # anyway); b.spec (1/3, 5 minutes) would have fitted after a.spec alone, but not after both.
        assert [row["spec"] for row in result["run"]] == ["a.spec.ts", "c.spec.ts"]
        assert [row["spec"] for row in result["left"]] == ["b.spec.ts"]
        assert result["minutes_run"] == 60

    def test_the_cap_stops_at_the_first_spec_past_it(self, repo, tmp_path):
        # a.spec scores most and is past the cap alone; b and c would fit after it, but the run
        # is the order's head, not the cheapest specs.
        write(repo, {"front-end/src/App.vue": "<p />\n", "front-end/src/views/Door.vue": "<p />\n"})
        results = seconds_file(tmp_path, {"a.spec.ts": 300, "b.spec.ts": 60, "c.spec.ts": 60})
        result = choose(repo, "--results", str(results), "--minutes", "3")
        assert result["run"] == []
        assert [row["spec"] for row in result["left"]] == ["a.spec.ts", "b.spec.ts", "c.spec.ts"]

    def test_the_minutes_fall_back_to_the_committed_timings_then_their_median(self, repo):
        write(
            repo,
            {
                "front-end/scripts/e2e-shard-timings.json": json.dumps(
                    {"a.spec.ts": 60, "b.spec.ts": 180, "x.spec.ts": 600}
                ),
                "front-end/src/App.vue": "<p />\n",
            },
        )
        rows = chosen(choose(repo))
        # c.spec.ts has no timing: the median of the timed files, 3 minutes.
        assert {s: r["minutes"] for s, r in rows.items()} == {
            "a.spec.ts": 1,
            "b.spec.ts": 3,
            "c.spec.ts": 3,
        }


class TestWhereTheMapComesFrom:
    def fake_gh(self, tmp_path, script):
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        gh = bin_dir / "gh"
        gh.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(script))
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        return {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}

    def test_with_no_map_it_says_so_and_runs_what_playwrights_only_changed_would(self, repo, tmp_path):
        env = self.fake_gh(tmp_path, "import sys\nsys.exit(1)\n")
        write(repo, {"front-end/e2e/helpers/seeds.ts": "// edit\n"})
        write(repo, {"front-end/e2e/c.spec.ts": "// edit\n"})
        write(repo, {"front-end/src/views/Door.vue": "<p />\n", "back-end/api/stats.py": None})
        write(repo, {"front-end/playwright.config.ts": "// edit\n"})
        result = choose(repo, env=env, fixture_map=False)
        assert result["map"] is None
        assert set(chosen(result)) == {"a.spec.ts", "c.spec.ts"}
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "--list"],
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **env},
        )
        assert done.returncode == 0, done.stderr
        assert "no test map" in done.stdout

    def test_the_newest_dev_map_is_downloaded_once_a_run(self, repo, tmp_path):
        log = tmp_path / "gh.log"
        env = self.fake_gh(
            tmp_path,
            f"""\
            import json, os, sys
            args = sys.argv[1:]
            open({str(log)!r}, "a").write(" ".join(args) + "\\n")
            if args[0] == "api":
                print(json.dumps({{"artifacts": [
                    {{"name": "test-map", "expired": False, "created_at": "2026-11-16T03:00:00Z",
                      "workflow_run": {{"id": 99, "head_branch": "fix/a-branch", "head_sha": "bb"}}}},
                    {{"name": "test-map", "expired": True, "created_at": "2026-11-16T02:00:00Z",
                      "workflow_run": {{"id": 88, "head_branch": "dev", "head_sha": "cc"}}}},
                    {{"name": "test-map", "expired": False, "created_at": "2026-11-16T01:00:00Z",
                      "workflow_run": {{"id": 77, "head_branch": "dev", "head_sha": "dd"}}}}]}}))
            elif args[:2] == ["run", "download"]:
                assert args[2] == "77", args
                out = args[args.index("-D") + 1]
                os.makedirs(out, exist_ok=True)
                if "-n" in args:
                    open(os.path.join(out, "test-map.json"), "w").write(
                        open({str(repo.parent / "test-map.json")!r}).read())
                else:
                    shard = os.path.join(out, "e2e-results-shard-1")
                    os.makedirs(shard)
                    open(os.path.join(shard, "results.json"), "w").write(json.dumps({{"suites": [
                        {{"file": "a.spec.ts", "specs": [{{"tests": [{{"results": [
                            {{"duration": 120000}}]}}]}}]}}]}}))
            """,
        )
        older = repo / ".stack-logs" / "test-map" / "55"
        older.mkdir(parents=True)
        (older / "test-map.json").write_text(json.dumps(MAP))
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        first = choose(repo, env=env, fixture_map=False)
        assert first["map"]["run"] == 77
        assert set(chosen(first)) == {"a.spec.ts"}
        assert chosen(first)["a.spec.ts"]["minutes"] == 2
        second = choose(repo, env=env, fixture_map=False)
        assert second["map"] == first["map"]
        downloads = [line for line in log.read_text().splitlines() if line.startswith("run download")]
        assert len(downloads) == 2  # the map and the shard results, once
        assert (repo / ".stack-logs" / "test-map" / "77" / "test-map.json").is_file()
        assert not older.exists()

    def test_offline_it_reads_the_map_it_downloaded_before(self, repo, tmp_path):
        cached = repo / ".stack-logs" / "test-map" / "77"
        cached.mkdir(parents=True)
        (cached / "test-map.json").write_text(json.dumps(MAP))
        env = self.fake_gh(tmp_path, "import sys\nsys.exit(1)\n")
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        result = choose(repo, env=env, fixture_map=False)
        assert result["map"]["run"] == 77
        assert result["map"]["offline"] is True
        assert set(chosen(result)) == {"a.spec.ts"}


class TestTheRun:
    def fake_npx(self, tmp_path):
        bin_dir = tmp_path / "npxbin"
        bin_dir.mkdir()
        npx = bin_dir / "npx"
        args = tmp_path / "npx-args.json"
        npx.write_text(
            "#!/usr/bin/env python3\nimport json, os, sys\n"
            f"json.dump({{'cwd': os.getcwd(), 'args': sys.argv[1:]}}, open({str(args)!r}, 'w'))\n"
            "sys.exit(3)\n"
        )
        npx.chmod(npx.stat().st_mode | stat.S_IEXEC)
        return {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}, args

    def run(self, repo, env, *extra):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--run", "--map", str(repo.parent / "test-map.json"), *extra],
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **env},
        )

    def test_it_runs_the_chosen_files_alone_and_answers_with_playwrights_status(self, repo, tmp_path):
        env, args = self.fake_npx(tmp_path)
        # `a.spec.ts` as a bare filter would also run `ba.spec.ts`, which the change does not reach.
        write(repo, {"front-end/e2e/ba.spec.ts": "import { test } from './fixtures';\n"})
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "ba.spec.ts")
        git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD")
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        done = self.run(repo, env, "--", "--retries=0")
        assert done.returncode == 3, done.stdout + done.stderr
        called = json.loads(args.read_text())
        assert Path(called["cwd"]).resolve() == (repo / "front-end").resolve()
        e2e = (repo / "front-end" / "e2e").resolve()
        assert called["args"] == [
            "playwright",
            "test",
            "/^" + affected_specs.escape(f"{e2e}/a.spec.ts") + "$/",
            "--retries=0",
        ]
        assert "a.spec.ts" in done.stdout
        assert "loads front-end/src/views/Door.vue" in done.stdout

    def test_a_spec_the_worktree_does_not_have_is_left_out(self, repo, tmp_path):
        env, args = self.fake_npx(tmp_path)
        test_map = dict(MAP, specs=dict(MAP["specs"]))
        test_map["specs"]["new-on-dev.spec.ts"] = {
            "modules": ["front-end/src/views/Door.vue"],
            "endpoints": [],
        }
        (repo.parent / "test-map.json").write_text(json.dumps(test_map))
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        done = self.run(repo, env)
        called = json.loads(args.read_text())
        assert len(called["args"]) == 3
        assert "new-on-dev.spec.ts" in done.stdout
        assert "not in this worktree" in done.stdout

    def test_nothing_reached_runs_nothing(self, repo, tmp_path):
        env, args = self.fake_npx(tmp_path)
        write(repo, {"docs/a-node.md": "words\n"})
        done = self.run(repo, env)
        assert done.returncode == 0
        assert not args.exists()
        assert "nothing to run" in done.stdout


def pr_report(tmp_path, shard, outcomes):
    """One shard's Playwright JSON report on the pull request, as the e2e job downloads it:
    `outcomes` maps a spec file to its tests' statuses, the first test inside a describe block."""
    tests = []
    for spec_file, statuses in outcomes.items():
        specs = [
            {"title": f"test {n}", "file": spec_file, "tests": [{"status": status, "results": []}]}
            for n, status in enumerate(statuses, start=1)
        ]
        tests.append(
            {
                "title": spec_file,
                "file": spec_file,
                "specs": specs[1:],
                "suites": [{"title": "a describe", "file": spec_file, "specs": specs[:1]}],
            }
        )
    report = tmp_path / "pr" / f"e2e-results-shard-{shard}" / "results.json"
    report.parent.mkdir(parents=True)
    report.write_text(json.dumps({"suites": tests}))
    return report


class TestTheAudit:
    """CI's e2e job on a pull request: each spec that failed in the shards, against what the
    selection would have chosen for the pull request's diff."""

    def audit(self, repo, *args, env=None):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "audit", "--base", "origin/dev", "--head", "HEAD",
             "--map", str(repo.parent / "test-map.json"), *args],
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **(env or {})},
        )  # fmt: skip
        assert done.returncode == 0, done.stdout + done.stderr
        return done.stdout

    def three_failures(self, repo, tmp_path):
        """a.spec ran (Door.vue, 10 minutes); b.spec was chosen but left to CI past the cap
        (check_in, 25 minutes after a.spec's 10); c.spec was not chosen at all."""
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        write(repo, {"back-end/api/door.py": DOOR_PY.replace('vendor["here"] = True', 'vendor["here"] = 1')})
        git(repo, "commit", "-qam", "the change")
        results = seconds_file(tmp_path, {"a.spec.ts": 10 * 60, "b.spec.ts": 25 * 60, "c.spec.ts": 60})
        reports = [
            pr_report(tmp_path, 1, {"a.spec.ts": ["passed", "unexpected"], "b.spec.ts": ["unexpected"]}),
            pr_report(tmp_path, 2, {"c.spec.ts": ["expected", "unexpected", "unexpected"]}),
        ]
        return ["--results", str(results), *map(str, reports)]

    def test_each_failed_spec_is_ran_left_to_ci_or_missed(self, repo, tmp_path):
        out = self.audit(repo, *self.three_failures(repo, tmp_path))
        lines = [line.strip() for line in out.splitlines()]
        assert any(line.startswith("ran: a.spec.ts") for line in lines), out
        assert any(line.startswith("left to CI: b.spec.ts") for line in lines), out
        assert any(line.startswith("missed: c.spec.ts") for line in lines), out
        assert "3 failed specs" in out
        assert "loads front-end/src/views/Door.vue" in out
        assert "back-end/api/door.py:check_in" in out

    def test_a_passing_or_skipped_spec_is_not_audited(self, repo, tmp_path):
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the change")
        report = pr_report(tmp_path, 1, {"b.spec.ts": ["expected", "expected"], "c.spec.ts": ["skipped"]})
        out = self.audit(repo, str(report))
        assert "no failure to audit" in out
        assert "b.spec.ts" not in out and "c.spec.ts" not in out

    def test_a_flaky_test_fails_its_shard_so_it_is_audited(self, repo, tmp_path):
        # Under CI, failOnFlakyTests fails a shard whose test passed only on a retry.
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the change")
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["expected", "flaky"], "c.spec.ts": ["expected"]})
        out = self.audit(repo, str(report))
        assert "ran: a.spec.ts" in out
        assert "c.spec.ts" not in out

    def test_with_github_a_miss_is_an_annotation_naming_the_changed_files(self, repo, tmp_path):
        summary = tmp_path / "summary.md"
        out = self.audit(
            repo, "--github", *self.three_failures(repo, tmp_path),
            env={"GITHUB_STEP_SUMMARY": str(summary)},
        )  # fmt: skip
        warnings = [line for line in out.splitlines() if line.startswith("::warning")]
        assert len(warnings) == 1, out
        assert warnings[0].startswith("::warning title=A miss of the selection::c.spec.ts ")
        assert "back-end/api/door.py" in warnings[0]
        assert "front-end/src/views/Door.vue" in warnings[0]
        written = summary.read_text()
        assert "### E2E selection audit" in written
        assert "| `a.spec.ts` | ran |" in written
        assert "| `b.spec.ts` | left to CI |" in written
        assert "| `c.spec.ts` | **missed** |" in written

    def test_with_github_no_failure_says_so_in_the_summary(self, repo, tmp_path):
        summary = tmp_path / "summary.md"
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["expected"]})
        out = self.audit(repo, "--github", str(report), env={"GITHUB_STEP_SUMMARY": str(summary)})
        assert "::warning" not in out
        assert "no failure to audit" in summary.read_text()

    @pytest.mark.parametrize("reports", [[], ["no-such.json", "broken.json"]])
    def test_with_no_report_read_it_says_there_was_nothing_to_audit(self, repo, tmp_path, reports):
        # The results' download failed, or every shard died before writing its report: that is
        # no sign that nothing failed.
        (tmp_path / "broken.json").write_text("{ not json")
        summary = tmp_path / "summary.md"
        out = self.audit(
            repo, "--github", *(str(tmp_path / r) for r in reports),
            env={"GITHUB_STEP_SUMMARY": str(summary)},
        )  # fmt: skip
        assert "no shard report was read: nothing to audit" in out
        assert "no failure to audit" not in out
        assert "No shard report was read: nothing to audit." in summary.read_text()

    def test_a_test_a_helper_registers_fails_under_the_spec_file_that_calls_it(self, repo, tmp_path):
        # Playwright's report gives a test the file its `test()` call is in, so the screen sweeps'
        # tests, registered by `helpers/screenSweeps.ts`, carry the helper's name; the spec file is
        # the top-level suite's, as `e2e-shards.ts` times it.
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the change")
        helper = "helpers/screenSweeps.ts"
        failed = {"title": "a screen", "file": helper, "tests": [{"status": "unexpected", "results": []}]}
        report = tmp_path / "pr" / "e2e-results-shard-1" / "results.json"
        report.parent.mkdir(parents=True)
        report.write_text(json.dumps({"suites": [{
            "title": "a.spec.ts", "file": "a.spec.ts", "specs": [],
            "suites": [{"title": "the sweeps", "file": helper, "specs": [failed]}],
        }]}))  # fmt: skip
        out = self.audit(repo, str(report))
        assert "ran: a.spec.ts" in out
        assert helper not in out

    def test_a_report_it_cannot_read_is_named_and_the_rest_audited(self, repo, tmp_path):
        args = self.three_failures(repo, tmp_path)
        broken = tmp_path / "pr" / "e2e-results-shard-3" / "results.json"
        broken.parent.mkdir(parents=True)
        broken.write_text("{ not json")
        out = self.audit(repo, *args, str(broken), str(tmp_path / "no-such.json"))
        assert "could not read" in out and str(broken) in out and "no-such.json" in out
        assert "missed: c.spec.ts" in out

    def test_an_audit_that_cannot_run_still_exits_zero(self, repo, tmp_path):
        summary = tmp_path / "summary.md"
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["unexpected"]})
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "audit", "--github", "--base", "no-such-commit",
             "--map", str(repo.parent / "test-map.json"), str(report)],
            cwd=repo, capture_output=True, text=True,
            env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary)},
        )  # fmt: skip
        assert done.returncode == 0, done.stdout + done.stderr
        assert "could not audit" in done.stdout
        assert "no-such-commit" in summary.read_text()

    def test_with_no_map_a_spec_outside_rule_one_is_missed_but_not_annotated(self, repo, tmp_path):
        # Before any run on dev has made a map, the selection is rule 1 alone, so a spec outside
        # it is listed, but is no sign of a drifted map or of a rule that cannot see a dependency.
        env = TestWhereTheMapComesFrom().fake_gh(tmp_path, "import sys\nsys.exit(1)\n")
        write(repo, {"front-end/e2e/c.spec.ts": "// edit\n", "front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the change")
        summary = tmp_path / "summary.md"
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["unexpected"], "c.spec.ts": ["unexpected"]})
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "audit", "--github", "--base", "origin/dev", "--head", "HEAD",
             str(report)],
            cwd=repo, capture_output=True, text=True,
            env={**os.environ, **env, "GITHUB_STEP_SUMMARY": str(summary)},
        )  # fmt: skip
        assert done.returncode == 0, done.stdout + done.stderr
        assert "ran: c.spec.ts" in done.stdout
        assert "missed: a.spec.ts: not chosen: with no test map" in done.stdout
        assert "::warning" not in done.stdout
        assert "| `a.spec.ts` | **missed** |" in summary.read_text()

    def test_a_spec_only_the_map_names_takes_no_minutes_from_the_run(self, repo, tmp_path):
        # As `--run` ranks: new-on-dev.spec (5 minutes) would rank before a.spec (28) and push it
        # past the cap of 30, but the head does not have it, so a builder's run never spent them.
        test_map = dict(MAP, specs=dict(MAP["specs"]))
        test_map["specs"]["new-on-dev.spec.ts"] = {"modules": ["front-end/src/views/Door.vue"], "endpoints": []}
        (repo.parent / "test-map.json").write_text(json.dumps(test_map))
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the change")
        results = seconds_file(tmp_path, {"new-on-dev.spec.ts": 5 * 60, "a.spec.ts": 28 * 60})
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["unexpected"]})
        out = self.audit(repo, "--results", str(results), str(report))
        assert "ran: a.spec.ts: rank 1" in out

    def queue_audit(self, repo, tmp_path, *args, env=None, fixture_map=True):
        """The merge queue's audit, with `--github`, of the trial commit at HEAD against the commit
        it was built on, its first parent: its log, and the job summary it wrote."""
        summary = tmp_path / "summary.md"
        command = [sys.executable, str(SCRIPT), "audit", "--queue", "--github",
                   "--base", "HEAD^1", "--head", "HEAD", *args]  # fmt: skip
        if fixture_map:
            command += ["--map", str(repo.parent / "test-map.json")]
        done = subprocess.run(
            command,
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **(env or {}), "GITHUB_STEP_SUMMARY": str(summary)},
        )
        assert done.returncode == 0, done.stdout + done.stderr
        return done.stdout, summary.read_text()

    def warnings(self, out):
        return [line for line in out.splitlines() if line.startswith("::warning")]

    def test_on_the_queue_a_spec_the_pull_requests_run_named_ran_there(self, repo, tmp_path):
        # a.spec (10 minutes) and b.spec (25) together pass a builder's cap of 30, which a pull
        # request's run does not have, so both ran there. c.spec's report is left out.
        *args, _ = self.three_failures(repo, tmp_path)
        out, written = self.queue_audit(repo, tmp_path, *args)
        door = "back-end/api/door.py:check_in via POST /checkin (1/1)"
        loads = "loads front-end/src/views/Door.vue (1/1)"
        lines = [line.strip() for line in out.splitlines()]
        assert f"ran on the pull request: a.spec.ts: {loads}" in lines, out
        assert f"ran on the pull request: b.spec.ts: {door}" in lines, out
        assert f"| `a.spec.ts` | ran on the pull request | {loads} |" in written
        assert f"| `b.spec.ts` | ran on the pull request | {door} |" in written
        assert self.warnings(out) == []

    def test_on_the_queue_a_spec_the_pull_requests_run_did_not_name_is_annotated(self, repo, tmp_path):
        write(repo, {"front-end/src/views/Door.vue": "<p />\n", "docs/a-node.md": "words\n"})
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "the trial commit")
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["unexpected"], "c.spec.ts": ["flaky"]})
        out, written = self.queue_audit(repo, tmp_path, str(report))
        left_out = "left out by the pull request's run"
        assert f"{left_out}: c.spec.ts: not named for this change" in out
        assert self.warnings(out) == [
            "::warning title=A spec the pull request's run left out::c.spec.ts failed, and the "
            "pull request's own E2E run would not have run it for this change of 2 files: "
            "docs/a-node.md, front-end/src/views/Door.vue"
        ]
        assert f"| `c.spec.ts` | **{left_out}** | not named for this change |" in written
        assert "| `a.spec.ts` | ran on the pull request |" in written

    def test_on_the_queue_a_change_naming_every_spec_ran_the_whole_suite(self, repo, tmp_path):
        write(repo, {"front-end/playwright.config.ts": "// edit\n"})
        git(repo, "commit", "-qam", "the trial commit")
        report = pr_report(tmp_path, 1, {"c.spec.ts": ["unexpected"]})
        out, written = self.queue_audit(repo, tmp_path, str(report))
        verdict = "the pull request ran the whole suite"
        assert f"{verdict}: c.spec.ts: the change names every spec" in out
        assert f"| `c.spec.ts` | {verdict} | the change names every spec |" in written
        assert self.warnings(out) == []

    def test_on_the_queue_with_no_map_the_pull_request_ran_the_whole_suite(self, repo, tmp_path):
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the trial commit")
        report = pr_report(tmp_path, 1, {"c.spec.ts": ["unexpected"]})
        env = TestWhereTheMapComesFrom().fake_gh(tmp_path, "import sys\nsys.exit(1)\n")
        out, written = self.queue_audit(repo, tmp_path, str(report), env=env, fixture_map=False)
        verdict = "the pull request ran the whole suite"
        assert f"{verdict}: c.spec.ts: there is no test map" in out
        assert f"| `c.spec.ts` | {verdict} | there is no test map |" in written
        assert self.warnings(out) == []
        # The choice a builder's run falls back to with no map is not CI's.
        assert "only-changed" not in out + written
        assert "1 file changed from " in out
        assert "1 file changed from " in written

    def test_the_queues_summary_says_what_was_decided_and_from_what(self, repo, tmp_path):
        write(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        git(repo, "commit", "-qam", "the trial commit")
        report = pr_report(tmp_path, 1, {"c.spec.ts": ["unexpected"]})
        _, written = self.queue_audit(repo, tmp_path, str(report))
        assert written.startswith("### E2E selection audit (merge queue)\n")
        source = f"The test map {repo.parent / 'test-map.json'}, at f00dfeed"
        assert f"{source}; 1 file changed from " in written
        assert "The decision for this diff: the test map names 1 spec file for this change." in written
        assert "| Failed spec | Verdict | Why |\n|---|---|---|\n| `c.spec.ts` |" in written
        assert "so a failure there met the queue first" in written
        assert "<details><summary>The 1 changed file</summary>" in written
        assert "- `front-end/src/views/Door.vue`" in written

    def test_a_queue_audit_that_cannot_run_still_exits_zero(self, repo, tmp_path):
        report = pr_report(tmp_path, 1, {"a.spec.ts": ["unexpected"]})
        out, written = self.queue_audit(repo, tmp_path, "--base", "no-such-commit", str(report))
        assert "could not audit" in out
        assert written.startswith("### E2E selection audit (merge queue)\n")
        assert "no-such-commit" in written

    def test_the_queues_audit_takes_no_cap(self, repo):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "audit", "--queue", "--minutes", "30"],
            cwd=repo, capture_output=True, text=True,
        )  # fmt: skip
        assert done.returncode == 2, done.stdout + done.stderr
        assert "takes no --minutes" in done.stderr


class TestTheCiDecision:
    """CI's pull request run: whether it runs the whole suite or the specs the map names, which
    ones and on how many shards, as one JSON object on stdout."""

    def command(self, repo, *args, fixture_map=True, max_shards=10):
        command = [sys.executable, str(SCRIPT), "ci", "--base", "origin/dev", "--head", "HEAD",
                   "--max-shards", str(max_shards), *args]  # fmt: skip
        if fixture_map:
            command += ["--map", str(repo.parent / "test-map.json")]
        return command

    def decide(self, repo, *args, env=None, **options):
        """The decision for the branch's commits: exit 0, and stdout holds that one object."""
        done = subprocess.run(
            self.command(repo, *args, **options),
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **(env or {})},
        )
        assert done.returncode == 0, done.stdout + done.stderr
        decision = json.loads(done.stdout)
        assert isinstance(decision, dict), done.stdout
        return decision

    def commit(self, repo, files):
        write(repo, files)
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "the change")

    def gh_fails(self, tmp_path):
        return TestWhereTheMapComesFrom().fake_gh(tmp_path, "import sys\nsys.exit(1)\n")

    def test_with_no_map_the_whole_suite_runs(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        decision = self.decide(repo, env=self.gh_fails(tmp_path), fixture_map=False, max_shards=7)
        assert decision["scope"] == "whole"
        assert decision["why"] == "there is no test map"
        assert decision["specs"] == []
        assert decision["shards"] == 7
        assert decision["map"] is None

    def gh_lists_a_map(self, repo, tmp_path, age):
        """A fake `gh` that lists one test map on dev, made `age` ago, and downloads it."""
        made = (datetime.now(timezone.utc) - age).strftime("%Y-%m-%dT%H:%M:%SZ")
        return TestWhereTheMapComesFrom().fake_gh(
            tmp_path,
            f"""\
            import json, os, sys
            args = sys.argv[1:]
            if args[0] == "api":
                print(json.dumps({{"artifacts": [
                    {{"name": "test-map", "expired": False, "created_at": {made!r},
                      "workflow_run": {{"id": 77, "head_branch": "dev"}}}}]}}))
            elif "-n" in args:
                out = args[args.index("-D") + 1]
                open(os.path.join(out, "test-map.json"), "w").write(
                    open({str(repo.parent / "test-map.json")!r}).read())
            """,
        )

    def test_a_map_downloaded_before_cannot_slim_the_run(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        cached = repo / ".stack-logs" / "test-map" / "77"
        cached.mkdir(parents=True)
        (cached / "test-map.json").write_text(json.dumps(MAP))
        decision = self.decide(repo, env=self.gh_fails(tmp_path), fixture_map=False)
        assert decision["scope"] == "whole"
        assert decision["why"] == "the test map could not be read from GitHub"
        assert decision["map"]["offline"] is True

    @pytest.mark.parametrize("days", [7, 8])
    def test_a_map_more_than_seven_days_old_cannot_slim_the_run(self, repo, tmp_path, days):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        env = self.gh_lists_a_map(repo, tmp_path, timedelta(days=days, hours=1))
        decision = self.decide(repo, env=env, fixture_map=False)
        assert decision["scope"] == "whole"
        assert decision["why"] == f"the newest test map is {days} days old"
        assert decision["specs"] == []
        assert decision["shards"] == 10

    def test_a_map_made_six_days_ago_slims_the_run(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        env = self.gh_lists_a_map(repo, tmp_path, timedelta(days=6, hours=23))
        decision = self.decide(repo, env=env, fixture_map=False)
        assert decision["scope"] == "named"
        assert decision["specs"] == ["a.spec.ts"]
        assert decision["map"]["run"] == 77

    def test_a_change_to_a_file_every_spec_stands_on_names_every_spec(self, repo):
        self.commit(repo, {"front-end/playwright.config.ts": "// edit\n"})
        decision = self.decide(repo)
        assert decision["scope"] == "whole"
        assert decision["why"] == "the change names every spec"
        assert decision["specs"] == []
        assert decision["shards"] == 10

    def test_a_docs_change_names_no_spec_and_takes_no_shard(self, repo):
        self.commit(repo, {"docs/a-node.md": "words\n"})
        decision = self.decide(repo)
        assert decision["scope"] == "named"
        assert decision["why"] == "the test map names no spec for this change"
        assert decision["specs"] == []
        assert decision["shards"] == 0
        assert decision["minutes"] == 0

    def test_a_change_one_specs_pages_load_names_that_spec(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        results = seconds_file(tmp_path, {"a.spec.ts": 300, "b.spec.ts": 120, "c.spec.ts": 60})
        decision = self.decide(repo, "--results", str(results))
        assert decision == {
            "scope": "named",
            "why": "the test map names 1 spec file for this change",
            "specs": ["a.spec.ts"],
            "shards": 1,
            "minutes": 5.0,
            "suite_minutes": 8.0,
            "map": {"file": str(repo.parent / "test-map.json"), "commit": "f00dfeed"},
        }

    def test_a_spec_the_map_names_that_the_head_lacks_is_not_named(self, repo):
        test_map = dict(MAP, specs=dict(MAP["specs"]))
        test_map["specs"]["new-on-dev.spec.ts"] = {
            "modules": ["front-end/src/views/Door.vue"],
            "endpoints": [],
        }
        (repo.parent / "test-map.json").write_text(json.dumps(test_map))
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        assert self.decide(repo)["specs"] == ["a.spec.ts"]

    @pytest.mark.parametrize(
        "seconds, max_shards, shards",
        [
            # The three named specs hold 12 of the suite's 60 seconds, two shards' share of ten.
            ({"a.spec.ts": 6, "b.spec.ts": 5, "c.spec.ts": 1, "d.spec.ts": 48}, 10, 2),
            # They hold 9 shards' share and part of another, but there are three specs.
            ({"a.spec.ts": 30, "b.spec.ts": 30, "c.spec.ts": 30, "d.spec.ts": 1}, 10, 3),
            # A whole run of two shards, or of one, is the most a named run takes.
            ({"a.spec.ts": 30, "b.spec.ts": 30, "c.spec.ts": 30, "d.spec.ts": 1}, 2, 2),
            ({"a.spec.ts": 30, "b.spec.ts": 30, "c.spec.ts": 30, "d.spec.ts": 1}, 1, 1),
            # Next to no minutes still takes a shard.
            ({"a.spec.ts": 0, "b.spec.ts": 0, "c.spec.ts": 0, "d.spec.ts": 60}, 10, 1),
        ],
    )
    def test_the_shards_scale_with_the_named_specs_minutes(
        self, repo, tmp_path, seconds, max_shards, shards
    ):
        # d.spec.ts loads nothing the change touches: it counts in the suite's minutes alone.
        base(repo, {"front-end/e2e/d.spec.ts": "import { test } from './fixtures';\n"})
        self.commit(repo, {"front-end/src/App.vue": "<p />\n"})
        results = seconds_file(tmp_path, seconds)
        decision = self.decide(repo, "--results", str(results), max_shards=max_shards)
        # Sorted by name, whatever the selection ranks first.
        assert decision["specs"] == ["a.spec.ts", "b.spec.ts", "c.spec.ts"]
        assert decision["shards"] == shards

    def test_one_long_spec_takes_one_shard(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        results = seconds_file(tmp_path, {"a.spec.ts": 100, "b.spec.ts": 1, "c.spec.ts": 1})
        assert self.decide(repo, "--results", str(results))["shards"] == 1

    @pytest.mark.parametrize(
        "name",
        [
            "with space.spec.ts",
            "café.spec.ts",
            'a"quote.spec.ts',
            "a\\backslash.spec.ts",
            "a\ttab.spec.ts",
        ],
    )
    def test_a_spec_name_the_run_cannot_pass_on_runs_the_whole_suite(self, repo, name):
        self.commit(repo, {f"front-end/e2e/{name}": "import { test } from './fixtures';\n"})
        decision = self.decide(repo)
        assert decision["scope"] == "whole"
        assert decision["why"] == f"a spec name the run cannot pass on: {name}"
        assert decision["specs"] == []

    @pytest.mark.parametrize(
        "given, named",
        [
            ([], "--max-shards"),
            (["--max-shards", "0"], "--max-shards"),
            # A pull request's run has no cap of minutes, so it takes none.
            (["--max-shards", "10", "--minutes", "5"], "--minutes"),
        ],
    )
    def test_a_usage_error_exits_2_and_decides_nothing(self, repo, given, named):
        done = subprocess.run(
            [sys.executable, str(SCRIPT), "ci", *given], cwd=repo, capture_output=True, text=True
        )
        assert done.returncode == 2, done.stdout + done.stderr
        assert named in done.stderr
        assert done.stdout == ""

    def summarize(self, repo, tmp_path, *args, **options):
        """The decision with `--github`: the job summary it appended, and the log on stderr."""
        summary = tmp_path / "summary.md"
        summary.write_text("an earlier step\n")
        done = subprocess.run(
            self.command(repo, "--github", *args, **options),
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, "GITHUB_STEP_SUMMARY": str(summary)},
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert json.loads(done.stdout)["scope"]
        written = summary.read_text()
        assert written.startswith("an earlier step\n### E2E selection\n")
        return written, done.stderr

    def test_the_summary_says_what_a_named_run_runs_and_why(self, repo, tmp_path):
        door_py = DOOR_PY.replace('vendor["here"] = True', 'vendor["here"] = 1')
        self.commit(
            repo, {"front-end/src/views/Door.vue": "<p />\n", "back-end/api/door.py": door_py}
        )
        results = seconds_file(tmp_path, {"a.spec.ts": 90, "b.spec.ts": 30, "c.spec.ts": 480})
        written, log = self.summarize(repo, tmp_path, "--results", str(results))
        sentence = (
            "Ran the 2 spec files the test map names for this change, 2.0 of 10.0 minutes, "
            "on 2 shards."
        )
        assert sentence in written
        source = f"The test map {repo.parent / 'test-map.json'}, at f00dfeed"
        assert f"{source}; 2 files changed from " in written
        assert "<details><summary>The 2 spec files named</summary>" in written
        assert "| `a.spec.ts` | 1.5 | loads front-end/src/views/Door.vue (1/1) |" in written
        door = "back-end/api/door.py:check_in via POST /checkin (1/1)"
        assert f"| `b.spec.ts` | 0.5 | {door} |" in written
        assert sentence in log
        assert "2 files changed from " in log

    def test_the_summary_counts_one_spec_and_one_shard_as_one(self, repo, tmp_path):
        self.commit(repo, {"front-end/src/views/Door.vue": "<p />\n"})
        results = seconds_file(tmp_path, {"a.spec.ts": 60, "b.spec.ts": 60, "c.spec.ts": 60})
        written, _ = self.summarize(repo, tmp_path, "--results", str(results))
        assert (
            "Ran the 1 spec file the test map names for this change, "
            "1.0 of 3.0 minutes, on 1 shard."
        ) in written

    def test_the_summary_says_a_change_that_names_no_spec_ran_none(self, repo, tmp_path):
        self.commit(repo, {"docs/a-node.md": "words\n"})
        written, _ = self.summarize(repo, tmp_path)
        assert "No E2E spec ran: the test map names none for this change." in written
        assert "1 file changed from " in written
        assert "<details>" not in written

    def test_the_summary_says_why_the_whole_suite_ran(self, repo, tmp_path):
        self.commit(repo, {"front-end/playwright.config.ts": "// edit\n"})
        written, log = self.summarize(repo, tmp_path)
        assert "Ran the whole suite: the change names every spec." in written
        assert "Ran the whole suite: the change names every spec." in log
        assert "<details>" not in written

    def test_the_summary_with_no_map_claims_no_choice_by_rule_one(self, repo, tmp_path):
        # `--run` and the audit fall back to rule 1 with no map; CI's run does not.
        self.commit(repo, {"front-end/e2e/c.spec.ts": "// edit\n"})
        summary = tmp_path / "summary.md"
        done = subprocess.run(
            self.command(repo, "--github", fixture_map=False),
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, **self.gh_fails(tmp_path), "GITHUB_STEP_SUMMARY": str(summary)},
        )
        assert done.returncode == 0, done.stdout + done.stderr
        written = summary.read_text()
        assert "Ran the whole suite: there is no test map." in written
        assert "only-changed" not in written + done.stderr
        assert "1 file changed from " in written

    def test_without_github_it_writes_no_summary(self, repo, tmp_path):
        self.commit(repo, {"docs/a-node.md": "words\n"})
        summary = tmp_path / "summary.md"
        self.decide(repo, env={"GITHUB_STEP_SUMMARY": str(summary)})
        assert not summary.exists()
