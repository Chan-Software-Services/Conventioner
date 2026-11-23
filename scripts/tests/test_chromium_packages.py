"""chromium-packages.sh run for real, with fakes of npx, sudo, apt-get, apt-config, dpkg-deb and
sleep on its PATH.

The fake npx answers `playwright install-deps --dry-run chromium` as Playwright does: the packages
still missing, or that none is. The fake apt-get installs, downloads and refreshes its lists, and
fails each call that reaches the mirrors while they are down. No real package is ever touched.
"""

import hashlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "chromium-packages.sh"

FONTS = ["fonts-wqy-zenhei", "fonts-ipafont-gothic", "xfonts-utils"]

FAKES = {
    "npx": r"""#!/usr/bin/env bash
echo "npx $*" >>"$FAKE/calls"
[[ "$*" == "playwright install-deps --dry-run chromium" ]] || exit 2
if [[ -f "$FAKE/no-lists" ]]; then
  echo "Failed to install browser dependencies"
  echo "Error: 'apt-get install -s' exited with code 100:"
  echo "E: Unable to locate package fonts-wqy-zenhei"
  exit 1
fi
if [[ -f "$FAKE/installed" || ! -s "$FAKE/missing" ]]; then
  echo "All system dependencies are installed."
  exit 0
fi
echo "Missing system dependencies ($(wc -l <"$FAKE/missing" | tr -d ' ')):"
sort "$FAKE/missing" | sed 's/^/  /'
exit 1
""",
    "sudo": r"""#!/usr/bin/env bash
echo "sudo $*" >>"$FAKE/calls"
exec "$@"
""",
    "apt-config": r"""#!/usr/bin/env bash
[[ "$*" == "shell archives Dir::Cache::Archives/d" ]] || exit 2
echo "archives='$FAKE/archives/'"
""",
    "dpkg-deb": r"""#!/usr/bin/env bash
# dpkg-deb --show of a package and its version, read from the fake's file name,
# <name>_<version>_all.deb.
[[ "$1 $2" == '--show --showformat=${Package} ${Version}\n' ]] || exit 2
name="$(basename "$3")"
version="${name#*_}"
echo "${name%%_*} ${version%_*}"
""",
    "sleep": r"""#!/usr/bin/env bash
echo "sleep $*" >>"$FAKE/calls"
""",
    "apt-get": r"""#!/usr/bin/env bash
echo "apt-get $*" >>"$FAKE/calls"
# The version the package lists name for every package.
version() { cat "$FAKE/version" 2>/dev/null || echo 1:1.0; }
# A call that reaches the mirrors fails while $FAKE/down holds a count above 0, and spends one.
reach_mirrors() {
  local down
  down="$(cat "$FAKE/down" 2>/dev/null || echo 0)"
  if (( down > 0 )); then
    echo $(( down - 1 )) >"$FAKE/down"
    echo "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu  Connection timed out" >&2
    exit 100
  fi
}
case "$1" in
  update)
    reach_mirrors
    rm -f "$FAKE/no-lists"
    # Fresh lists name newer versions of the packages whose old ones are gone.
    if [[ -f "$FAKE/gone" ]]; then rm "$FAKE/gone"; echo 1:1.1 >"$FAKE/version"; fi
    ;;
  download)
    reach_mirrors
    # The versions the lists name are gone from the mirrors, until the lists are refreshed.
    [[ ! -f "$FAKE/gone" ]] || { echo "E: Failed to fetch ... 404  Not Found" >&2; exit 100; }
    shift
    for package in "$@"; do echo "deb of $package" >"${package}_$(version)_all.deb"; done
    ;;
  install)
    if [[ "$2" == -s ]]; then
      shift 3  # install -s --no-install-recommends
      for package in "$@"; do
        echo "Inst $package ($(version) Ubuntu:26.04/resolute [all])"
      done
      exit 0
    fi
    if [[ " $* " == *" --no-download "* ]]; then
      # Only what apt's archive directory holds, at the versions the lists name.
      [[ ! -f "$FAKE/stale" ]] || { echo "E: Unable to fetch some archives" >&2; exit 100; }
      shift 4  # install -y --no-install-recommends --no-download
      for package in "$@"; do
        [[ -f "$FAKE/archives/${package}_$(version)_all.deb" ]] || { echo "E: Unable to fetch $package" >&2; exit 100; }
      done
    else
      reach_mirrors
    fi
    touch "$FAKE/installed"
    ;;
  *) exit 2 ;;
esac
""",
}


@pytest.fixture
def fake(tmp_path):
    state = tmp_path / "fake"
    state.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    (state / "missing").write_text("".join(f"{package}\n" for package in FONTS))
    (state / "calls").touch()
    (state / "archives").mkdir()
    return state


def run(fake, *args):
    output = fake.parent / "github-output"
    output.write_text("")
    env = {k: v for k, v in os.environ.items() if k != "GITHUB_OUTPUT"}
    env.update(
        FAKE=str(fake),
        PATH=f"{fake.parent / 'bin'}:{os.environ['PATH']}",
        GITHUB_OUTPUT=str(output),
    )
    result = subprocess.run([str(SCRIPT), *args], env=env, capture_output=True, text=True)
    outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
    return result, outputs


def calls(fake):
    return fake.joinpath("calls").read_text().splitlines()


def mirror_calls(fake):
    """The apt-get calls that would reach Ubuntu's mirrors: all but a simulation (`install -s`) and
    an install that may download nothing (`--no-download`)."""
    return [
        call
        for call in calls(fake)
        if call.startswith(("apt-get update", "apt-get download"))
        or (
            call.startswith("apt-get install")
            and not call.startswith("apt-get install -s ")
            and "--no-download" not in call
        )
    ]


def install(fake, debs):
    return run(fake, "install", str(debs), *sorted(FONTS))


@pytest.fixture
def debs(tmp_path):
    return tmp_path / "chromium-packages"


def cached(debs, packages=FONTS):
    debs.mkdir(exist_ok=True)
    for package in packages:
        (debs / f"{package}_1:1.0_all.deb").write_text(f"deb of {package}")


class TestMissing:
    def test_it_names_the_missing_packages_sorted_with_a_hash_of_them(self, fake):
        result, outputs = run(fake, "missing")

        assert result.returncode == 0, result.stderr
        assert outputs["packages"] == " ".join(sorted(FONTS))
        assert len(outputs["hash"]) == 64
        assert mirror_calls(fake) == []
        assert not [call for call in calls(fake) if call.startswith("sudo")]

    def test_the_hash_is_the_same_for_the_same_packages_and_another_for_others(self, fake):
        _, first = run(fake, "missing")
        _, again = run(fake, "missing")
        fake.joinpath("missing").write_text("fonts-unifont\n")
        _, other = run(fake, "missing")

        assert again["hash"] == first["hash"]
        assert other["hash"] != first["hash"]

    def test_another_version_in_the_runners_package_lists_is_another_hash(self, fake):
        _, first = run(fake, "missing")
        fake.joinpath("version").write_text("1:1.1")
        _, newer = run(fake, "missing")

        assert newer["hash"] != first["hash"]
        assert newer["packages"] == first["packages"]

    def test_the_hash_covers_the_operating_system_and_each_packages_version(self, fake):
        _, outputs = run(fake, "missing")
        release = subprocess.run(
            ["bash", "-c", '. /etc/os-release && printf "%s %s" "$ID" "${VERSION_ID:-}"'],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        versions = "".join(f"{package} 1:1.0\n" for package in sorted(FONTS))

        expected = hashlib.sha256(f"{release}\n{versions}".encode()).hexdigest()
        assert outputs["hash"] == expected

    def test_none_missing_names_none(self, fake):
        fake.joinpath("missing").write_text("")

        result, outputs = run(fake, "missing")

        assert result.returncode == 0, result.stderr
        assert outputs["packages"] == ""

    def test_with_no_package_lists_it_refreshes_them_and_asks_again(self, fake):
        fake.joinpath("no-lists").touch()

        result, outputs = run(fake, "missing")

        assert result.returncode == 0, result.stderr
        assert outputs["packages"] == " ".join(sorted(FONTS))
        assert "sudo apt-get update" in calls(fake)

    def test_an_answer_it_cannot_read_fails(self, fake, tmp_path):
        (tmp_path / "bin" / "npx").write_text('#!/usr/bin/env bash\necho "something else"\nexit 1\n')

        result, _ = run(fake, "missing")

        assert result.returncode != 0
        assert "something else" in result.stderr


class TestInstallFromTheCache:
    def test_it_installs_the_cached_packages_without_reaching_the_mirrors(self, fake, debs):
        cached(debs)

        result, outputs = install(fake, debs)

        assert result.returncode == 0, result.stderr
        assert mirror_calls(fake) == []
        [installing] = [call for call in calls(fake) if call.startswith("sudo apt-get install")]
        assert installing == (
            "sudo apt-get install -y --no-install-recommends --no-download " + " ".join(sorted(FONTS))
        )
        assert sorted(path.name for path in fake.joinpath("archives").iterdir()) == sorted(
            f"{package}_1:1.0_all.deb" for package in FONTS
        )
        assert outputs["cacheable"] == "true"

    def test_cached_packages_that_no_longer_install_come_from_the_mirrors(self, fake, debs):
        cached(debs)
        fake.joinpath("stale").touch()

        result, outputs = install(fake, debs)

        assert result.returncode == 0, result.stderr
        assert mirror_calls(fake) == [
            "apt-get update",
            "apt-get install -y --no-install-recommends " + " ".join(sorted(FONTS)),
        ]
        assert outputs["cacheable"] == "false"

    def test_the_install_from_the_mirrors_is_retried_as_a_whole(self, fake, debs):
        cached(debs)
        fake.joinpath("stale").touch()
        fake.joinpath("down").write_text("2")

        result, _ = install(fake, debs)

        assert result.returncode == 0, result.stderr
        assert mirror_calls(fake) == ["apt-get update"] * 3 + [
            "apt-get install -y --no-install-recommends " + " ".join(sorted(FONTS)),
        ]
        assert [call for call in calls(fake) if call.startswith("sleep")] == ["sleep 60"] * 2

    def test_a_package_still_missing_after_the_install_fails_it(self, fake, debs, tmp_path):
        cached(debs)
        apt_get = tmp_path / "bin" / "apt-get"
        apt_get.write_text(apt_get.read_text().replace('touch "$FAKE/installed"', ":"))

        result, _ = install(fake, debs)

        assert result.returncode != 0
        assert "Missing system dependencies" in result.stderr


class TestInstallOnAMiss:
    def test_it_downloads_the_packages_it_lacks_then_installs_them_from_the_cache_directory(
        self, fake, debs
    ):
        cached(debs, FONTS[:1])

        result, outputs = install(fake, debs)

        assert result.returncode == 0, result.stderr
        assert mirror_calls(fake) == ["apt-get download " + " ".join(sorted(FONTS[1:]))]
        assert sorted(path.name for path in debs.iterdir()) == sorted(
            f"{package}_1:1.0_all.deb" for package in FONTS
        )
        assert outputs["cacheable"] == "true"

    def test_versions_gone_from_the_mirrors_are_downloaded_again_from_refreshed_lists(
        self, fake, debs
    ):
        fake.joinpath("gone").touch()

        result, outputs = install(fake, debs)

        assert result.returncode == 0, result.stderr
        download = "apt-get download " + " ".join(sorted(FONTS))
        assert mirror_calls(fake) == [download, "apt-get update", download]
        assert not [call for call in calls(fake) if call.startswith("sleep")]
        # The files are not the versions the key names, so they are not kept under it.
        assert outputs["cacheable"] == "false"

    def test_a_short_outage_is_waited_out(self, fake, debs):
        fake.joinpath("down").write_text("5")

        result, outputs = install(fake, debs)

        assert result.returncode == 0, result.stderr
        download = "apt-get download " + " ".join(sorted(FONTS))
        assert mirror_calls(fake) == [download, "apt-get update"] * 2 + [download, "apt-get update", download]
        assert [call for call in calls(fake) if call.startswith("sleep")] == ["sleep 60"] * 2
        assert outputs["cacheable"] == "true"

    def test_it_tries_six_times_a_minute_apart_then_fails(self, fake, debs):
        fake.joinpath("down").write_text("1000")

        result, _ = install(fake, debs)

        assert result.returncode != 0
        download = "apt-get download " + " ".join(sorted(FONTS))
        assert mirror_calls(fake) == [download, "apt-get update"] * 6
        assert [call for call in calls(fake) if call.startswith("sleep")] == ["sleep 60"] * 5
        assert "failed 6 times" in result.stderr
        assert not fake.joinpath("installed").exists()


def test_it_runs_without_shellcheck_findings():
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck is not installed")
    result = subprocess.run(["shellcheck", str(SCRIPT)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout
