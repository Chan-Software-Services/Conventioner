"""No test reaches a database the shell that runs the suite names.

A shell may have exported ``MONGODB_URI`` or ``MONGODB_HOST`` and the rest (to run a one-off script
against a stack, say). ``conftest.py`` used to keep them and point the suite at its unreachable
address only when none was set, so a test that reached a collection no fake stands in for talked to
that database instead of failing fast.
``conftest.py`` therefore clears each before any test runs and names its unreachable address, and a
test that needs one sets it itself. This is what keeps that true. The real-MongoDB suite reads
``REAL_MONGODB_URI``, which this leaves alone.
"""
import json
import os
import subprocess
import sys

from conftest import MONGO_ENV_KEYS, UNREACHABLE_MONGODB_URI, skip_without_real_dependencies

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))

#: Run in a process of its own, as pytest starts: load conftest, then read what a test would.
_PROBE = f"""
import json, os, sys
sys.path.insert(0, {TESTS_DIR!r})
import conftest
seen = {{"environment": {{name: os.environ.get(name) for name in conftest.MONGO_ENV_KEYS}}}}
if not conftest.STUBBED_MODULES:
    from db_config import get_mongodb_client
    client = get_mongodb_client()
    seen["dials"] = sorted(":".join(map(str, seed)) for seed in client.topology_description.server_descriptions())
    client.close()
print(json.dumps(seen))
"""

#: Fixture values for every variable, each naming a port nothing listens on.
_A_SHELLS_DATABASE = {
    "MONGODB_URI": "mongodb://127.0.0.1:9/",
    "MONGODB_HOST": "127.0.0.1",
    "MONGODB_PORT": "9",
    "MONGODB_USER": "fixture-user",
    "MONGODB_PASSWORD": "fixture-password",
    "MONGODB_AUTH_DB": "fixture",
}


def _what_a_test_sees(**exported):
    """What a test reads of the ``MONGODB_*`` variables, and the server it would dial, when the
    suite is run from a shell that exported ``exported``."""
    environment = {key: value for key, value in os.environ.items() if key not in MONGO_ENV_KEYS}
    environment.update(exported)
    done = subprocess.run(
        [sys.executable, "-c", _PROBE],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return json.loads(done.stdout.strip().splitlines()[-1])


def _only_the_unreachable_address():
    return {name: UNREACHABLE_MONGODB_URI if name == "MONGODB_URI" else None for name in MONGO_ENV_KEYS}


def test_every_variable_the_shell_exported_gives_way_to_the_unreachable_address():
    assert set(_A_SHELLS_DATABASE) == set(MONGO_ENV_KEYS)

    seen = _what_a_test_sees(**_A_SHELLS_DATABASE)

    assert seen["environment"] == _only_the_unreachable_address()


def test_a_shell_that_exported_only_a_host_gives_way_too():
    seen = _what_a_test_sees(MONGODB_HOST="127.0.0.1", MONGODB_PORT="9")

    assert seen["environment"] == _only_the_unreachable_address()


def test_a_shell_that_exported_none_sees_the_unreachable_address():
    assert _what_a_test_sees()["environment"] == _only_the_unreachable_address()


def test_a_test_dials_the_unreachable_address_whatever_the_shell_named():
    skip_without_real_dependencies()

    assert _what_a_test_sees(**_A_SHELLS_DATABASE)["dials"] == ["127.0.0.1:1"]
