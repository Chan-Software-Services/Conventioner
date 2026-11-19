"""Only an asking, the unasked door or an applicant's own save writes a market's history through
the history's writer (T105-9, ADR 0038).

A change on a market records under the row its request asked: through the ``Asked`` its check
returned (``Actions.Asked.record``), or, for the few records no request asks, through
``History.unasked``, which only the functions in ``DOORS`` call, each with its reason. The history's
writer is private (``History._record``): among the server modules, only the history module and
the asking's ``record`` call it, and only ``api.market_actions`` (through ``ask``) and ``history``
(through ``unasked``) build the two recorders. This file reads every server module
and fails one that uses the history's private writers or its collection through the history
module, opens the unasked door outside ``DOORS``, or builds a recorder by hand, so an entry can
never name a row passed by hand beside a check made elsewhere.

What each write records, and under which row, is ``test_every_write_records.py``'s: it sends each
write and ties each entry to a row the write asked, or to one of its ``UNASKED``.
"""
import ast
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional

BACK_END = Path(__file__).resolve().parents[1]

#: The two modules that write a market's entry: the history itself, and the asking's ``record``.
WRITERS = ("history", "api.market_actions")

#: What of the history module writes an entry past the asking: its private writers and its
#: collection, and ``record``, the writer's public name before T105-9, so that it cannot come back.
PRIVATE = ("_record", "_write", "history_collection", "record")

#: The two recorders, each by the one module allowed to build it: an ``Asked`` built anywhere but by
#: ``ask``, or an ``UnaskedRecorder`` anywhere but by ``unasked``, would record under a row passed by
#: hand, past the asking and past ``DOORS``.
BUILDERS: Dict[str, str] = {"Asked": "api.market_actions", "UnaskedRecorder": "history"}

#: The functions allowed to open the door for a record no request asked, by module and name, each
#: with the constant beside it that says why, which its call passes as ``because``.
DOORS: Dict[str, str] = {
    "csv_import.enter_review": "FIRST_IMPORT_MOVES_UNASKED",
    "csv_start.confirm": "START_RELEASES_UNASKED",
    "review_team._deal_arriving": "ARRIVALS_DEAL_UNASKED",
    "api.vendor_check_in.check_in": "VENDORS_OWN_CHECK_IN_UNASKED",
    "api.vendor_check_in.undo_check_in": "VENDORS_OWN_CHECK_IN_UNASKED",
    "seed_test_markets.seed_test_market": "SEEDER_MOVES_UNASKED",
    "migrations.migrate_owed_day_state.record_dropped": "MIGRATION_DROPS_UNASKED",
    "migrations.swap_location_names.record_swapped": "SWAP_RECORDS_UNASKED",
}


class Reading(NamedTuple):
    """What a module does with the history: each way it writes past the asking, and each door it
    opens as allowed, as ``module.function``."""
    found: List[str]
    doors: List[str]


def _sources():
    """Every server module but the tests, by its dotted name, parsed."""
    for path in sorted(BACK_END.rglob("*.py")):
        parts = path.relative_to(BACK_END).parts
        if {"tests", "__pycache__", "flask_session"} & set(parts):
            continue
        module = ".".join(parts)[:-3]
        yield module, ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _names_of(tree: ast.AST, module: str) -> set:
    """The names the module binds ``module`` to, ``import history as History`` and the rest,
    wherever it imports it."""
    return {
        alias.asname or (alias.name if "." not in alias.name else None)
        for node in ast.walk(tree) if isinstance(node, ast.Import)
        for alias in node.names if alias.name == module
    } - {None}


def _history_names(tree: ast.AST) -> set:
    """The names the module binds the history module to."""
    return _names_of(tree, "history")


def _builders_by_name(tree: ast.AST) -> Dict[str, str]:
    """Each name the module binds a recorder to by importing it by name, as the recorder's name."""
    return {
        alias.asname or alias.name: alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module in BUILDERS.values()
        for alias in node.names if BUILDERS.get(alias.name) == node.module
    }


def _because(call: ast.Call) -> Optional[str]:
    """The name of the constant a door's call gives as its reason, or how it gives one otherwise."""
    for keyword in call.keywords:
        if keyword.arg == "because":
            value = keyword.value
            return value.id if isinstance(value, ast.Name) else ast.unparse(value)
    return None


def read(tree: ast.AST, module: str) -> Reading:
    """Where ``module`` writes the history past the asking: any use of a private writer outside the
    two writers, any import of one by name (an alias would hide the rest), and any use of the
    unasked door but a call from a function of ``DOORS`` giving its reason, and any recorder built
    outside the module that builds it (``BUILDERS``)."""
    history = _history_names(tree)
    owners = {"history": history, "api.market_actions": _names_of(tree, "api.market_actions")}
    by_name = _builders_by_name(tree)
    reading = Reading([], [])

    def built(call: ast.Call) -> Optional[str]:
        """The recorder ``call`` builds, when it builds one outside its own module."""
        func = call.func
        if isinstance(func, ast.Name):
            recorder = by_name.get(func.id)
        elif (isinstance(func, ast.Attribute) and func.attr in BUILDERS
              and isinstance(func.value, ast.Name)
              and func.value.id in owners[BUILDERS[func.attr]]):
            recorder = func.attr
        else:
            recorder = None
        return recorder if recorder and BUILDERS[recorder] != module else None

    def of_the_history(node: ast.AST, names) -> bool:
        return (isinstance(node, ast.Attribute) and node.attr in names
                and isinstance(node.value, ast.Name) and node.value.id in history)

    def visit(node: ast.AST, function: str) -> None:
        where = function or "the module"
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                visit(child, f"{function}.{child.name}" if function else child.name)
                continue
            if isinstance(child, ast.ImportFrom) and child.module == "history":
                for alias in child.names:
                    if alias.name in PRIVATE + ("unasked", "UnaskedRecorder", "*"):
                        reading.found.append(f"{module}:{child.lineno} imports {alias.name}")
                continue
            if isinstance(child, ast.Call) and built(child):
                reading.found.append(f"{module}:{child.lineno} builds {built(child)} in {where}")
            if isinstance(child, ast.Call) and of_the_history(child.func, ("unasked",)):
                door, because = f"{module}.{function}", _because(child)
                if door not in DOORS:
                    reading.found.append(f"{module}:{child.lineno} unasked in {where}")
                elif because != DOORS[door]:
                    reading.found.append(
                        f"{module}:{child.lineno} unasked in {where} because {because}, "
                        f"not {DOORS[door]}")
                else:
                    reading.doors.append(door)
                for part in (*child.args, *child.keywords):
                    visit(part, function)
                continue
            if of_the_history(child, ("unasked",)):
                reading.found.append(f"{module}:{child.lineno} unasked in {where}")
            elif of_the_history(child, PRIVATE) and module not in WRITERS:
                reading.found.append(f"{module}:{child.lineno} {child.attr} in {where}")
            visit(child, function)

    visit(tree, "")
    return reading


def _constant(tree: ast.AST, name: str) -> Optional[str]:
    """The string a module-level constant of ``tree`` holds, or None."""
    for node in tree.body:
        if (isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == name for target in node.targets)
                and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)):
            return node.value.value
    return None


def test_no_module_writes_a_markets_history_but_through_an_asking_or_its_door():
    assert [what for module, tree in _sources() for what in read(tree, module).found] == []


def test_every_door_allowed_is_still_opened_where_it_is_allowed():
    """A door moved or renamed fails here, rather than leaving an allowance nothing uses."""
    opened = {door for module, tree in _sources() for door in read(tree, module).doors}

    assert opened == set(DOORS)


def test_each_door_says_why_beside_it():
    trees = dict(_sources())

    for door, because in DOORS.items():
        module = door.rsplit(".", 1)[0]
        assert (_constant(trees[module], because) or "").strip(), f"{door}: {because}"


def _reading(source: str, module: str = "api.somewhere") -> List[str]:
    found = read(ast.parse(source), module).found
    return [what.split(" ", 1)[1] for what in found]


def test_the_search_finds_each_way_past_the_asking():
    """The search above is only as good as what it catches: each way a module could write a
    market's history with no asking, and each door opened where it is not allowed."""
    assert _reading(
        "import history as History\n"
        "def by_hand(market_id, user):\n"
        "    History._record(market_id, user, Actions.CHANGE_SETUP, detail={})\n"
        "def under_the_writer(market_id, user):\n"
        "    History._write({'market_id': market_id}, user, 'assign', None, (), None, {})\n"
        "def by_the_old_name(market_id, user):\n"
        "    History.record(market_id, user, Actions.ASSIGN, detail={})\n"
        "def straight_to_the_collection(entry):\n"
        "    History.history_collection.insert_one(entry)\n"
        "WRITE = History._record\n"
        "class Recorder:\n"
        "    def record(self, **entry):\n"
        "        History._record(self.market_id, self.actor, self.row, **entry)\n"
        "def opening_a_door(market_id):\n"
        "    History.unasked(market_id, None, Actions.CHECK_IN, because=SOME_REASON)\n"
        "OPEN = History.unasked\n"
        "import api.market_actions as Actions\n"
        "def an_asking_by_hand(market_id, user):\n"
        "    Actions.Asked(Actions.ASSIGN, market_id, user, None).record(detail={})\n"
        "def a_door_by_hand(market_id):\n"
        "    History.UnaskedRecorder(market_id, None, Actions.CHECK_IN, 'why').record(detail={})\n"
        "from api.market_actions import Asked as Let\n"
        "def an_asking_imported_by_name(market_id, user):\n"
        "    Let(Actions.ASSIGN, market_id, user, None).record(detail={})\n"
        "from history import UnaskedRecorder\n"
    ) == [
        "_record in by_hand",
        "_write in under_the_writer",
        "record in by_the_old_name",
        "history_collection in straight_to_the_collection",
        "_record in the module",
        "_record in Recorder.record",
        "unasked in opening_a_door",
        "unasked in the module",
        "builds Asked in an_asking_by_hand",
        "builds UnaskedRecorder in a_door_by_hand",
        "builds Asked in an_asking_imported_by_name",
        "imports UnaskedRecorder",
    ]


def test_an_alias_or_an_import_by_name_is_found():
    assert _reading(
        "def inside(market_id, user):\n"
        "    import history as H\n"
        "    H._record(market_id, user, Actions.ASSIGN, detail={})\n"
        "from history import _record, unasked as door, APPLY\n"
        "from history import *\n"
    ) == [
        "_record in inside",
        "imports _record",
        "imports unasked",
        "imports *",
    ]


def test_a_door_is_its_module_and_function_with_its_reason():
    assert _reading(
        "import history as History\n"
        "def enter_review(market_id, by):\n"
        "    History.unasked(market_id, by, Actions.MOVE_PHASE,\n"
        "                    because=FIRST_IMPORT_MOVES_UNASKED)\n"
        "class Import:\n"
        "    def enter_review(self, market_id, by):\n"
        "        History.unasked(market_id, by, Actions.MOVE_PHASE,\n"
        "                        because=FIRST_IMPORT_MOVES_UNASKED)\n",
        module="csv_start",
    ) == ["unasked in enter_review", "unasked in Import.enter_review"]

    assert _reading(
        "import history as History\n"
        "def enter_review(market_id, by):\n"
        "    History.unasked(market_id, by, Actions.MOVE_PHASE, because=START_RELEASES_UNASKED)\n"
        "def confirm(market_id, by):\n"
        "    History.unasked(market_id, by, Actions.MOVE_PHASE, because='the import asked it')\n",
        module="csv_import",
    ) == [
        "unasked in enter_review because START_RELEASES_UNASKED, not FIRST_IMPORT_MOVES_UNASKED",
        "unasked in confirm",
    ]


def test_what_is_allowed_is_not_found():
    """The two writers' own use of the private writer, a door called as allowed, a record through
    the asking, and the history's other names, which write no market's entry past it."""
    private = (
        "import history as History\n"
        "def record(self, **entry):\n"
        "    History._record(self.market_id, self.actor, self.row, **entry)\n"
    )
    assert _reading(private, module="api.market_actions") == []
    assert _reading(private, module="history") == []

    built = (
        "import api.market_actions as Actions\n"
        "import history as History\n"
        "def ask(row, user, market):\n"
        "    return Actions.Asked(row, market.id, user, None)\n"
        "def unasked(market_id, actor, row, because):\n"
        "    return History.UnaskedRecorder(market_id, actor, row, because)\n"
    )
    assert _reading(built, module="api.market_actions") == [
        "builds UnaskedRecorder in unasked"]
    assert _reading(built, module="history") == ["builds Asked in ask"]
    assert _reading(
        "import api.market_actions as Actions\n"
        "from api.market_actions import Asked\n"
        "import history as History\n"
        "def write(asked: Actions.Asked, recorder: History.Recorder) -> Actions.Asked:\n"
        "    return asked\n"
    ) == []

    door = read(ast.parse(
        "import history as History\n"
        "def enter_review(market_id, by):\n"
        "    MarketsApi.take_move(context, 'applications', History.unasked(\n"
        "        market_id, by, Actions.MOVE_PHASE, because=FIRST_IMPORT_MOVES_UNASKED))\n"
    ), "csv_import")
    assert door == Reading([], ["csv_import.enter_review"])

    assert _reading(
        "import history as History\n"
        "from history import HISTORY_COLLECTION, placement_subject\n"
        "def write(change, recorder):\n"
        "    change.asked.record(kind=History.RENAMED, detail={})\n"
        "    History.record_placed(recorder, placement)\n"
        "    History.record_applicant(market_id, applicant, History.SUBMITTED, app_id, {})\n"
        "    History.record_for_organization(org_id, actor, History.RENAMED, detail={})\n"
        "    record = History.entries_page(market_id)\n"
        "    other._record(market_id)\n"
    ) == []
