"""seed_walk_market.sh seeds the walk's market only on a stack it was told, as seed_fixture.sh does.

It takes the stack exactly as seed_fixture.sh does (the exported stack, the treehouse slot, or
`--primary`) and refuses anything else, and it never starts a stack: Daniel's own stack and another
task's must never receive a walk's market by a guess.

The script is run for real, with the stub `docker` and `th-compose.sh` of `stacks.py`, which log
every call; each case here stops before the script dials a back end.
"""

import pytest
from stacks import REPO, run_seed, slot_path

WALK = REPO / "scripts" / "seed_walk_market.sh"
EXPLICIT = {"COMPOSE_PROJECT_NAME": "nmtest-1", "TH_MONGO_PORT": "49153", "TH_BACKEND_PORT": "49154", "TH_FRONTEND_PORT": "49155"}


def walk(checkout, tmp_path, *args, **env):
    return run_seed(checkout, tmp_path, *args, script=WALK, **env)


def test_with_no_stack_given_it_refuses_and_touches_nothing(tmp_path):
    result, calls = walk(tmp_path / "Conventioner", tmp_path)

    assert result.returncode == 2
    assert calls == []
    assert "refusing to guess" in result.stderr
    for remedy in ("th-compose.sh ports", "--primary"):
        assert remedy in result.stderr


def test_a_stack_named_in_part_is_refused(tmp_path):
    result, calls = walk(tmp_path / "Conventioner", tmp_path, COMPOSE_PROJECT_NAME="nmtest-1")

    assert result.returncode == 2
    assert calls == []
    assert "names only part of a stack" in result.stderr


@pytest.mark.parametrize("where", ["slot", "exported"])
def test_primary_beside_another_stack_is_refused(tmp_path, where):
    if where == "slot":
        result, calls = walk(slot_path(tmp_path, 3), tmp_path, "--primary")
    else:
        result, calls = walk(tmp_path / "Conventioner", tmp_path, "--primary", **EXPLICIT)

    assert result.returncode == 2
    assert calls == []
    assert "--primary" in result.stderr


def test_an_unknown_argument_is_refused(tmp_path):
    result, calls = walk(slot_path(tmp_path, 3), tmp_path, "--yes")

    assert result.returncode == 2
    assert calls == []
    assert "unknown argument" in result.stderr


@pytest.mark.parametrize(
    "where, env, ports",
    [
        ("slot", {}, "backend=5031, frontend=5203"),
        ("exported", EXPLICIT, "backend=49154, frontend=49155"),
    ],
)
def test_it_reads_the_stack_it_was_told_and_never_starts_one(tmp_path, where, env, ports):
    checkout = slot_path(tmp_path, 3) if where == "slot" else tmp_path / "Conventioner"
    result, calls = walk(checkout, tmp_path, STACK_STOPPED="1", **env)

    assert f"(ports: {ports})" in result.stdout
    assert result.returncode == 3
    assert "never starts one" in result.stderr
    assert calls == ["th-compose.sh ps --format {{.Service}}"]


def test_both_seeds_take_the_stack_by_the_one_rule():
    # One copy of the guard, scripts/lib/stack-identity.sh, so a fix to it reaches both seeds.
    rule = (REPO / "scripts" / "lib" / "stack-identity.sh").read_text()
    assert "stack_identity()" in rule
    for seed in ("seed_fixture.sh", "seed_walk_market.sh"):
        text = (REPO / "scripts" / seed).read_text()
        assert 'source "$SCRIPT_DIR/lib/stack-identity.sh"' in text, seed
        assert 'stack_identity "$PROJECT_DIR" "$PRIMARY"' in text, seed
        # Neither reads a slot or a stack's variables by a copy of its own.
        assert "STACK_VARS" not in text and r"\.treehouse/" not in text, seed
