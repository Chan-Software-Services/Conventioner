"""No test's result depends on the test switches of the shell that runs the suite.

A shell that ran a stack, or ``scripts/nm-test.sh``'s E2E phase, may have exported
``DISABLE_CAPTCHA``, ``DISABLE_EMAIL`` or ``DISCORD_FAKE``. The suite turns the escape hatch on for
every run, which honours each, so an exported ``DISCORD_FAKE=true`` handed Discord's credentials and
requests to the fake, and most Discord connection tests failed there while passing in CI, whose
``backend`` job sets none.
``conftest.py`` therefore clears each switch before any test runs, and a test that needs one sets it
itself. This is what keeps that true.
"""
import os
import subprocess
import sys

from utils.deployment import INSECURE_LOCAL_DEV_VAR, LOCAL_SWITCHES

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))

#: The switches the hatch honours: every local switch but the hatch itself.
TEST_SWITCHES = tuple(name for name in LOCAL_SWITCHES if name != INSECURE_LOCAL_DEV_VAR)

#: Run in a process of its own, as pytest starts: load conftest, then read what a test would.
_PROBE = f"""
import json, os, sys
sys.path.insert(0, {TESTS_DIR!r})
import conftest
from utils.deployment import switch_on
print(json.dumps({{name: switch_on(name) for name in {list(LOCAL_SWITCHES)!r}}}))
"""


def _switches_a_test_sees(environment):
    """What each local switch reads as to a test, when the suite is run with ``environment``."""
    import json

    done = subprocess.run(
        [sys.executable, "-c", _PROBE],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(done.stdout.strip().splitlines()[-1])


def _shell(**exported):
    environment = {key: value for key, value in os.environ.items() if key not in LOCAL_SWITCHES}
    environment.update(exported)
    return environment


def test_the_guard_knows_every_test_switch():
    assert {"DISABLE_CAPTCHA", "DISABLE_EMAIL", "DISCORD_FAKE"} <= set(TEST_SWITCHES)


def test_a_switch_the_shell_exported_is_off_in_every_test():
    seen = _switches_a_test_sees(_shell(**{name: "true" for name in TEST_SWITCHES}))

    assert {name: seen[name] for name in TEST_SWITCHES} == {name: False for name in TEST_SWITCHES}


def test_a_shell_that_exported_none_sees_none():
    seen = _switches_a_test_sees(_shell())

    assert {name: seen[name] for name in TEST_SWITCHES} == {name: False for name in TEST_SWITCHES}


def test_the_hatch_stays_on_for_the_tests_that_set_a_switch():
    """A test that sets a switch with ``monkeypatch.setenv`` still finds it honoured."""
    assert _switches_a_test_sees(_shell(**{name: "true" for name in TEST_SWITCHES}))[INSECURE_LOCAL_DEV_VAR]
