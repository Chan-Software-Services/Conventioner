"""The app hashes a password at bcrypt's full cost, and only the tests' accounts at its lowest.

A hash at bcrypt's cost of 12, flask-bcrypt's default, takes about 0.16 s, and the tests make
thousands: so ``conftest`` lowers the cost to 4 for every test, on flask-bcrypt's ``Bcrypt`` class,
and ``create_test_user.py`` hashes the E2E suite's fixture accounts at 4. Neither may reach the
app or the operator's ``create_account.py``: production keeps the default, and sets no
``BCRYPT_LOG_ROUNDS`` of its own. They are imported here in a fresh interpreter with flask-bcrypt
as installed, so they hash as they do in production.
"""
import subprocess
import sys
from pathlib import Path

from conftest import TEST_BCRYPT_ROUNDS, skip_without_real_dependencies

skip_without_real_dependencies()

import app as app_module  # noqa: E402
import create_account as CreateAccount  # noqa: E402
import create_test_user as CreateTestUser  # noqa: E402

BACK_END = Path(__file__).resolve().parent.parent

PRODUCTION_ROUNDS = 12

# conftest is imported for the stand-ins the app's boot checks are answered by, never reaching a
# database; whatever it changed on flask-bcrypt's class is put back before the app is imported.
HASH_AS_THE_APP_BOOTS = """
import sys
import flask_bcrypt
as_installed = dict(vars(flask_bcrypt.Bcrypt))
sys.path.insert(0, "tests")
import conftest
for name, value in as_installed.items():
    if not name.startswith("__"):
        setattr(flask_bcrypt.Bcrypt, name, value)
import app
import create_account
import create_test_user
print("BCRYPT_LOG_ROUNDS" in app.app.config)
print(app.bcrypt.generate_password_hash("fixture-password").decode())
print(create_account.bcrypt.generate_password_hash("fixture-password").decode())
print(create_test_user._hashed("fixture-password"))
"""


def _cost(pw_hash: str) -> int:
    return int(pw_hash.split("$")[2])


def test_the_app_hashes_at_bcrypts_full_cost():
    run = subprocess.run(
        [sys.executable, "-c", HASH_AS_THE_APP_BOOTS],
        cwd=BACK_END, capture_output=True, text=True, timeout=120,
    )
    assert run.returncode == 0, run.stderr

    sets_rounds, app_hash, operator_hash, fixture_hash = run.stdout.split()[-4:]
    assert sets_rounds == "False", "the app's config sets no BCRYPT_LOG_ROUNDS"
    assert _cost(app_hash) == PRODUCTION_ROUNDS
    assert _cost(operator_hash) == PRODUCTION_ROUNDS
    assert _cost(fixture_hash) == CreateTestUser.FIXTURE_BCRYPT_ROUNDS == 4


def test_the_suite_hashes_at_bcrypts_lowest_cost():
    assert TEST_BCRYPT_ROUNDS == 4
    hashes = (
        app_module.bcrypt.generate_password_hash("fixture-password").decode(),
        CreateAccount.bcrypt.generate_password_hash("fixture-password").decode(),
        CreateTestUser._hashed("fixture-password"),
    )

    assert [_cost(pw_hash) for pw_hash in hashes] == [TEST_BCRYPT_ROUNDS] * 3
