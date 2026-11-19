"""``application_status`` is the only module that writes an application's review state (ADR 0037).

The review state is ``ReviewState.OWNED_FIELDS``: the status, the verdict's giver, time and
reason, the follow-up's owner, what an undo returns to, who added the vendor and when, the origin,
the mark for the deal and the reviewer whose share it is. A rule about how an application moves
between states is kept only if every move is written in one place, so a second writer is a bug
waiting for the rule it forgot.

This walks every ``.py`` file under ``back-end/`` but ``tests/`` by AST, as
``test_every_market_write_holds_what_it_read.py`` walks the markets collection, and finds each call
of a write method whose receiver is the applications collection: a name or attribute ending in
``applications_collection`` or ``applications``, a subscript of ``"applications"`` or
``APPLICATIONS_COLLECTION``, or a name its function or its module binds to one of those, so a write
through a local alias of the collection is seen too. Each must be in ``application_status.py`` or
in ``EXCEPTIONS``, keyed by module and function, with its reason; a receiver the walk cannot name
may be the applications collection too, so it must be listed the same way.

An excepted write must name no owned field in what it writes: its update (each key of each
operator, ``$set`` and ``$unset`` among them, exact or as a dotted path under one), its replacement,
or the document it inserts. The walk reads a dict literal, or a name bound to one at module level,
and an excepted write it cannot read fails, naming its file and line, until it is written so. A
write's filter may name an owned field: the claim holds the status it read. A one-time migration an
operator runs is listed but not read, since it runs outside any request and outside the owner's
rules by design.

Its second check (T277 ticket 02) reads every back-end module outside the owner, ``tests/`` and
``migrations/`` for a read of a status the review no longer writes (``RETIRED``):
``ApplicationStatus.UNDER_REVIEW``, an old offers flow's status, or ``CANCELLED``. A module that
names one spells a state out again beside ``ReviewState.state_of``, which reads every stored
spelling as the state it stands for, so it fails unless ``RETIRED_EXCEPTIONS`` lists it, keyed by
module and function, with its reason. ``datatypes.py`` defines the members by assignment, which is
not a read.
"""
import ast
from pathlib import Path
from typing import Dict, FrozenSet, Iterable, Iterator, List, NamedTuple, Optional, Tuple

import conftest

import application_status as ReviewState

BACK_END_DIR = Path(conftest.BACK_END_DIR)

WRITE_METHODS = frozenset({
    "insert_one", "insert_many", "update_one", "update_many", "replace_one",
    "find_one_and_update", "find_one_and_replace", "delete_one", "delete_many", "bulk_write",
})
_DELETES = frozenset({"delete_one", "delete_many"})

#: The one module whose writes to the applications collection need no reason.
OWNER = "application_status"

_A_MIGRATION = "a one-time migration an operator runs outside any request"
_THE_CLAIM = (
    "the claim (ADR 0014): who is looking at an application now, held on the claim it read, which "
    "is not the review state")
_A_DELETE = "a delete writes no field, so it moves no application between states"

#: Each write to the applications collection outside the owner, by (module, function), and why.
EXCEPTIONS: Dict[Tuple[str, str], str] = {
    ("api.applications", "claim_next_for_review"): _THE_CLAIM,
    ("api.applications", "renew_claim"): _THE_CLAIM,
    ("api.applications", "release_claim"): _THE_CLAIM,
    ("api.applications", "delete_applications_for_market"): (
        f"{_A_DELETE}: a market's applications go with the market (market_deletion)"),
    ("api.applications", "delete_application"): (
        f"{_A_DELETE}: undoing a create whose answers were then refused"),
    ("reset_database", "reset_database"): (
        "an operator script emptying every collection of a local database, which it names by a "
        "variable the walk cannot read"),
    ("migrations.migrate_application_status", "written"): _A_MIGRATION,
    ("migrations.migrate_submitted_at_to_iso", "migrate"): _A_MIGRATION,
    ("migrations.migrate_table_share_answer", "migrate"): _A_MIGRATION,
    ("migrations.migrate_tier_preference_per_date", "migrate"): _A_MIGRATION,
}


#: The statuses the review no longer writes: ``under_review``, which ``open`` replaced, and the old
#: offers flow's. Only the owner names one, reading it as the state it stands for.
RETIRED = frozenset({
    "UNDER_REVIEW", "UNASSIGNED", "ASSIGNED", "ASSIGNMENT_SENT", "VENDOR_ACCEPTED",
    "VENDOR_REFUSED", "CANCELLED",
})

#: Each read of a ``RETIRED`` status outside the owner, by (module, function), and why.
RETIRED_EXCEPTIONS: Dict[Tuple[str, str], str] = {
    ("app", "pending_offers_count"): (
        "the offers stage's count of sent offers, which nothing enters and T277 ticket 14 removes"),
}


class Site(NamedTuple):
    """One write call: where it is, whether its receiver is the applications collection (None when
    the walk cannot tell), and the call itself."""
    path: Path
    line: int
    module: str
    function: str
    method: str
    to_applications: Optional[bool]
    call: ast.Call
    bound: Dict[str, ast.expr]


def _named(node: ast.expr) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _to_applications(receiver: ast.expr, aliases: FrozenSet[str] = frozenset()) -> Optional[bool]:
    """Whether ``receiver`` is the applications collection, by its name, or a name ``aliases`` holds
    as bound to it; None when it has none."""
    if isinstance(receiver, ast.Name) and receiver.id in aliases:
        return True
    name = _named(receiver)
    if name is not None:
        return name.endswith("applications_collection") or name.endswith("applications")
    if isinstance(receiver, ast.Subscript):
        key = receiver.slice
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            return key.value == "applications"
        key_name = _named(key)
        if key_name is not None and key_name.isupper():
            return key_name == "APPLICATIONS_COLLECTION"
    return None


def _module(path: Path, root: Path) -> str:
    return ".".join(path.relative_to(root).with_suffix("").parts)


def _walked(relative: Tuple[str, ...]) -> bool:
    """A file of the back end's own: not a test's, and not under a hidden directory or in an
    installed package (a virtual environment kept under ``back-end/``)."""
    return (relative[0] != "tests" and "site-packages" not in relative
            and not any(part.startswith(".") or part == "__pycache__" for part in relative))


def _module_bindings(tree: ast.Module) -> Dict[str, ast.expr]:
    """Each name the module binds once, at its top level, to what it binds it to."""
    bound: Dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name):
                bound[target.id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value:
            bound[node.target.id] = node.value
    return bound


def _aliases(nodes: Iterable[ast.AST], outer: FrozenSet[str] = frozenset()) -> FrozenSet[str]:
    """The names ``nodes`` bind to the applications collection, as the walk names it, or to a name
    already bound to it, beside those ``outer`` holds: so ``collection = ...applications_collection``
    makes ``collection`` the collection."""
    assigns = [(node.targets[0].id, node.value) for node in nodes
               if isinstance(node, ast.Assign) and len(node.targets) == 1
               and isinstance(node.targets[0], ast.Name)]
    assigns += [(node.target.id, node.value) for node in nodes
                if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
                and node.value is not None]
    aliases = set(outer)
    grown = True
    while grown:
        grown = False
        for name, value in assigns:
            if name not in aliases and _to_applications(value, frozenset(aliases)):
                aliases.add(name)
                grown = True
    return frozenset(aliases)


def write_sites(root: Path) -> Iterator[Site]:
    """Every call of a write method in the back end's own ``.py`` files under ``root``."""
    for path in sorted(root.rglob("*.py")):
        if not _walked(path.relative_to(root).parts):
            continue
        tree = ast.parse(path.read_text(), str(path))
        yield from _Walk(path, _module(path, root), _module_bindings(tree)).sites(tree)


class _Walk(ast.NodeVisitor):
    def __init__(self, path: Path, module: str, bound: Dict[str, ast.expr]):
        self.path, self.module, self.bound = path, module, bound
        self.scope: List[str] = []
        self.found: List[Site] = []
        self.aliases: List[FrozenSet[str]] = []

    def sites(self, tree: ast.Module) -> List[Site]:
        self.aliases.append(_aliases(tree.body))
        self.visit(tree)
        return self.found

    def _scoped(self, node):
        self.scope.append(node.name)
        self.aliases.append(_aliases(ast.walk(node), self.aliases[-1]))
        self.generic_visit(node)
        self.aliases.pop()
        self.scope.pop()

    visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scoped

    def visit_Call(self, node: ast.Call):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in WRITE_METHODS:
            self.found.append(Site(self.path, node.lineno, self.module,
                                   ".".join(self.scope) or "<module>", func.attr,
                                   _to_applications(func.value, self.aliases[-1]), node,
                                   self.bound))
        self.generic_visit(node)


class Unreadable(Exception):
    """What a write writes is not a dict literal, or a name bound to one at module level."""


def _dict(node: ast.expr, bound: Dict[str, ast.expr]) -> ast.Dict:
    if isinstance(node, ast.Name) and node.id in bound:
        node = bound[node.id]
    if not isinstance(node, ast.Dict):
        raise Unreadable()
    return node


def _keys(node: ast.expr, bound: Dict[str, ast.expr]) -> Iterator[Tuple[str, ast.expr]]:
    """Each key of a dict as written, with its value; a ``**`` spread of a readable dict gives its
    keys too."""
    literal = _dict(node, bound)
    for key, value in zip(literal.keys, literal.values):
        if key is None:
            yield from _keys(value, bound)
        elif isinstance(key, ast.Constant) and isinstance(key.value, str):
            yield key.value, value
        else:
            raise Unreadable()


def written_paths(update: ast.expr, bound: Dict[str, ast.expr]) -> List[str]:
    """The field paths an update, a replacement or an inserted document writes: each operator's
    keys, and a document's own keys. Raises ``Unreadable`` when the walk cannot read them."""
    paths: List[str] = []
    for key, value in _keys(update, bound):
        if key.startswith("$"):
            paths.extend(path for path, _value in _keys(value, bound))
        else:
            paths.append(key)
    return paths


def _owned(path: str) -> bool:
    return any(path == field or path.startswith(f"{field}.") for field in ReviewState.OWNED_FIELDS)


def _argument(call: ast.Call, index: int, keyword: str) -> Optional[ast.expr]:
    if len(call.args) > index:
        return call.args[index]
    return next((kw.value for kw in call.keywords if kw.arg == keyword), None)


def _what_it_writes(site: Site) -> List[ast.expr]:
    """The documents a write writes, each to be read for owned fields. Raises ``Unreadable`` when
    the walk cannot find them."""
    if site.method in ("update_one", "update_many", "find_one_and_update"):
        written = [_argument(site.call, 1, "update")]
    elif site.method in ("replace_one", "find_one_and_replace"):
        written = [_argument(site.call, 1, "replacement")]
    elif site.method == "insert_one":
        written = [_argument(site.call, 0, "document")]
    elif site.method == "insert_many":
        documents = _argument(site.call, 0, "documents")
        if not isinstance(documents, (ast.List, ast.Tuple)):
            raise Unreadable()
        written = list(documents.elts)
    else:  # bulk_write: its operations are not read here
        raise Unreadable()
    if any(document is None for document in written):
        raise Unreadable()
    return written


def _owned_written(site: Site) -> List[str]:
    """The owned fields an excepted write writes. Raises ``Unreadable`` when the walk cannot read
    what it writes."""
    if site.method in _DELETES:
        return []
    return [path for document in _what_it_writes(site)
            for path in written_paths(document, site.bound) if _owned(path)]


def unexcused(root: Path, exceptions: Dict[Tuple[str, str], str]) -> List[str]:
    """What fails the guard, by file and line: each write to the applications collection, or to a
    receiver the walk cannot name, outside the owner and the exceptions; and each excepted write
    that names an owned field, or whose update the walk cannot read."""
    failures = []
    for site in write_sites(root):
        if site.to_applications is False or site.module == OWNER:
            continue
        where = f"{site.path.relative_to(root)}:{site.line}"
        if (site.module, site.function) not in exceptions:
            if site.to_applications is None:
                failures.append(
                    f"{where}: the walk cannot name the receiver of {site.method} in "
                    f"{site.function}; name the collection, or list the site with its reason")
            else:
                failures.append(
                    f"{where}: {site.method} on the applications collection in {site.function}, "
                    f"outside {OWNER}; write the review state through it, or list the site with "
                    "its reason")
            continue
        if site.module.startswith("migrations."):
            continue
        try:
            owned = _owned_written(site)
        except Unreadable:
            failures.append(
                f"{where}: the walk cannot read what {site.method} in {site.function} writes; "
                "write it as a dict literal, or a name bound to one at module level")
            continue
        if owned:
            failures.append(
                f"{where}: {site.method} in {site.function} writes {', '.join(owned)}, the review "
                f"state, which only {OWNER} writes")
    return failures


def _listed_sites(root: Path) -> set:
    return {(site.module, site.function) for site in write_sites(root)
            if site.to_applications is not False and site.module != OWNER}


def test_only_the_owner_writes_the_review_state():
    assert unexcused(BACK_END_DIR, EXCEPTIONS) == []


def test_every_exception_names_a_site_that_still_writes():
    """An exception whose write moved into the owner, or went, leaves the list with it."""
    assert set(EXCEPTIONS) - _listed_sites(BACK_END_DIR) == set()


def test_every_exception_says_why():
    assert [site for site, reason in EXCEPTIONS.items() if len(reason.split()) < 4] == []


def test_the_owner_writes_the_applications_collection():
    """The walk sees the owner's own writes, so it would see one written anywhere else."""
    assert any(site.module == OWNER and site.to_applications
               for site in write_sites(BACK_END_DIR))


def test_the_owned_fields_are_the_review_state():
    """A field dropped from the list would be written anywhere unseen, so the list is pinned."""
    assert set(ReviewState.OWNED_FIELDS) == {
        "status", "verdict_by", "verdict_at", "verdict_reason", "follow_up_owner", "undo_to",
        "added_by", "added_at", "origin", "arriving", "reviewer"}


class RetiredRead(NamedTuple):
    """One read of a status the review no longer writes, by file, line, module and function."""
    path: Path
    line: int
    module: str
    function: str
    member: str


def _reads_retired(node: ast.AST) -> Optional[str]:
    """The ``RETIRED`` member ``node`` reads, as ``ApplicationStatus.X`` or as
    ``<module>.ApplicationStatus.X``, or None."""
    if not (isinstance(node, ast.Attribute) and node.attr in RETIRED
            and isinstance(node.ctx, ast.Load)):
        return None
    return node.attr if _named(node.value) == "ApplicationStatus" else None


class _RetiredWalk(ast.NodeVisitor):
    def __init__(self, path: Path, module: str):
        self.path, self.module = path, module
        self.scope: List[str] = []
        self.found: List[RetiredRead] = []

    def _scoped(self, node):
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_FunctionDef = visit_AsyncFunctionDef = visit_ClassDef = _scoped

    def visit_Attribute(self, node: ast.Attribute):
        member = _reads_retired(node)
        if member:
            self.found.append(RetiredRead(self.path, node.lineno, self.module,
                                          ".".join(self.scope) or "<module>", member))
        self.generic_visit(node)


def retired_reads(root: Path) -> Iterator[RetiredRead]:
    """Every read of a ``RETIRED`` status in a back-end module outside the owner, ``tests/`` and
    ``migrations/``: a one-time migration reads the stored spellings to rewrite them."""
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root).parts
        module = _module(path, root)
        if not _walked(relative) or relative[0] == "migrations" or module == OWNER:
            continue
        walk = _RetiredWalk(path, module)
        walk.visit(ast.parse(path.read_text(), str(path)))
        yield from walk.found


def unexcused_reads(root: Path, exceptions: Dict[Tuple[str, str], str]) -> List[str]:
    """What fails the second check, by file and line: each read of a ``RETIRED`` status outside
    the owner and the exceptions."""
    return [
        f"{read.path.relative_to(root)}:{read.line}: ApplicationStatus.{read.member} read in "
        f"{read.function}, outside {OWNER}; read the state through ReviewState.state_of, or list "
        "the site with its reason"
        for read in retired_reads(root) if (read.module, read.function) not in exceptions]


def test_no_reader_outside_the_owner_names_a_status_the_review_no_longer_writes():
    assert unexcused_reads(BACK_END_DIR, RETIRED_EXCEPTIONS) == []


def test_every_retired_exception_names_a_site_that_still_reads_one():
    """An exception whose read went (T277 ticket 14 removes the offers stage) leaves the list."""
    read = {(site.module, site.function) for site in retired_reads(BACK_END_DIR)}
    assert set(RETIRED_EXCEPTIONS) - read == set()


def test_every_retired_exception_says_why():
    assert [site for site, reason in RETIRED_EXCEPTIONS.items() if len(reason.split()) < 4] == []


def test_the_owner_reads_the_retired_statuses_unseen_by_the_check():
    """The owner reads every spelling as the state it stands for, which is what the check sends
    every other reader to; ``datatypes.py`` defines them, by assignment, which is not a read."""
    path = BACK_END_DIR / "application_status.py"
    walk = _RetiredWalk(path, OWNER)
    walk.visit(ast.parse(path.read_text()))
    # The walk sees the owner's reads, so it would see one anywhere else.
    assert {read.member for read in walk.found} >= {"UNDER_REVIEW", "CANCELLED"}
    assert not [read for read in retired_reads(BACK_END_DIR)
                if read.module in (OWNER, "datatypes")]


class TestThePlantedRead:
    @staticmethod
    def _tree(tmp_path, source: str, path: str = "api/planted.py") -> Path:
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_text(source)
        return tmp_path

    def test_a_module_naming_under_review_fails_it_by_file_and_line(self, tmp_path):
        root = self._tree(tmp_path, (
            "from datatypes import ApplicationStatus\n"
            "def undecided(app):\n"
            "    return app.status in (ApplicationStatus.OPEN, ApplicationStatus.UNDER_REVIEW)\n"))

        assert unexcused_reads(root, RETIRED_EXCEPTIONS) == [
            "api/planted.py:3: ApplicationStatus.UNDER_REVIEW read in undecided, outside "
            "application_status; read the state through ReviewState.state_of, or list the site "
            "with its reason"]

    def test_every_retired_status_is_found_however_the_enum_is_reached(self, tmp_path):
        root = self._tree(tmp_path, "".join(
            f"X{index} = datatypes.ApplicationStatus.{member}\n"
            for index, member in enumerate(sorted(RETIRED))))

        assert [failure.split(": ")[1].split(" ")[0]
                for failure in unexcused_reads(root, {})] == [
            f"ApplicationStatus.{member}" for member in sorted(RETIRED)]

    def test_a_status_the_review_writes_passes(self, tmp_path):
        root = self._tree(tmp_path, (
            "def f():\n"
            "    return (ApplicationStatus.OPEN, ApplicationStatus.NEEDS_FOLLOW_UP,\n"
            "            ApplicationStatus.REVIEWER_APPROVED, ApplicationStatus.REVIEWER_REJECTED)\n"))

        assert unexcused_reads(root, {}) == []

    def test_listing_the_read_lets_it_pass(self, tmp_path):
        root = self._tree(tmp_path, "def count():\n    return ApplicationStatus.ASSIGNMENT_SENT\n")

        assert unexcused_reads(root, {("api.planted", "count"): "a reason"}) == []

    def test_the_owner_the_tests_the_migrations_and_a_definition_are_not_read(self, tmp_path):
        root = self._tree(tmp_path, "X = ApplicationStatus.UNDER_REVIEW\n", "application_status.py")
        self._tree(root, "X = ApplicationStatus.UNDER_REVIEW\n", "tests/test_x.py")
        self._tree(root, "X = ApplicationStatus.UNDER_REVIEW\n", "migrations/migrate_x.py")
        self._tree(root, "class ApplicationStatus:\n    UNDER_REVIEW = 'under_review'\n",
                   "datatypes.py")

        assert unexcused_reads(root, {}) == []


class TestThePlantedWrite:
    @staticmethod
    def _tree(tmp_path, source: str, name: str = "planted.py") -> Path:
        (tmp_path / "api").mkdir(exist_ok=True)
        (tmp_path / "api" / name).write_text(source)
        (tmp_path / "tests").mkdir(exist_ok=True)
        (tmp_path / "tests" / "test_x.py").write_text(
            "def f():\n    applications_collection.update_one({}, {'$set': {'status': 'open'}})\n")
        return tmp_path

    def test_a_write_outside_the_list_fails_it_by_file_and_line(self, tmp_path):
        root = self._tree(tmp_path, (
            "def approve(app_id):\n"
            "    applications_collection.update_one({'id': app_id}, {'$set': {'x': 1}})\n"))

        assert unexcused(root, EXCEPTIONS) == [
            "api/planted.py:2: update_one on the applications collection in approve, outside "
            "application_status; write the review state through it, or list the site with its "
            "reason"]

    def test_a_write_through_a_name_bound_to_the_collection_fails_it(self, tmp_path):
        """A name bound to the collection, in its function or its module, is the collection, so
        a write through an alias of it is seen as one."""
        root = self._tree(tmp_path, (
            "import api.applications as ApplicationsApi\n"
            "module_alias = ApplicationsApi.applications_collection\n"
            "def approve(app_id):\n"
            "    collection = ApplicationsApi.applications_collection\n"
            "    again = collection\n"
            "    collection.update_one({'id': app_id}, {'$set': {'x': 1}})\n"
            "    again.update_one({'id': app_id}, {'$set': {'x': 1}})\n"
            "    module_alias.update_one({'id': app_id}, {'$set': {'x': 1}})\n"
            "def elsewhere(app_id):\n"
            "    collection = markets_collection\n"
            "    collection.update_one({'id': app_id}, {'$set': {'x': 1}})\n"))

        assert [failure.split(": ")[0] for failure in unexcused(root, EXCEPTIONS)] == [
            "api/planted.py:6", "api/planted.py:7", "api/planted.py:8"]

    def test_listing_a_write_of_no_owned_field_lets_it_pass(self, tmp_path):
        root = self._tree(tmp_path, (
            "def hold(app_id):\n"
            "    applications_collection.update_one(\n"
            "        {'id': app_id, 'status': 'open'}, {'$set': {'held_by': 'ana'}})\n"))

        assert unexcused(root, {("api.planted", "hold"): "a reason"}) == []

    def test_an_excepted_write_of_an_owned_field_fails_by_file_and_line(self, tmp_path):
        root = self._tree(tmp_path, (
            "def hold(app_id):\n"
            "    applications_collection.update_one(\n"
            "        {'id': app_id}, {'$set': {'held_by': 'ana', 'status': 'open'}})\n"))

        assert unexcused(root, {("api.planted", "hold"): "a reason"}) == [
            "api/planted.py:2: update_one in hold writes status, the review state, which only "
            "application_status writes"]

    def test_every_owned_field_is_found_in_every_place_an_update_names_it(self, tmp_path):
        root = self._tree(tmp_path, (
            "_UNSET = {'undo_to': '', 'held_by': ''}\n"
            "def hold(app_id):\n"
            "    applications_collection.update_one({}, {'$unset': {'verdict_by.kind': ''}})\n"
            "    applications_collection.update_one({}, {'$unset': _UNSET})\n"
            "    applications_collection.update_one({}, {'$set': {**_UNSET}})\n"
            "    applications_collection.find_one_and_update({}, {'$setOnInsert': {'reviewer': 1}})\n"
            "    applications_collection.replace_one({}, {'arriving': 1})\n"
            "    applications_collection.insert_one({'added_by': 1})\n"
            "    applications_collection.insert_many([{'origin': 1}])\n"
            "    applications_collection.update_many({}, update={'$set': {'follow_up_owner': 1}})\n"))

        assert [failure.split(" writes ")[1].split(",")[0]
                for failure in unexcused(root, {("api.planted", "hold"): "a reason"})] == [
            "verdict_by.kind", "undo_to", "undo_to", "reviewer", "arriving", "added_by", "origin",
            "follow_up_owner"]

    def test_a_field_whose_name_only_begins_like_an_owned_one_passes(self, tmp_path):
        root = self._tree(tmp_path, (
            "def hold(app_id):\n"
            "    applications_collection.update_one({}, {'$set': {'status_note': 1, "
            "'reviewers': 1}})\n"))

        assert unexcused(root, {("api.planted", "hold"): "a reason"}) == []

    def test_an_excepted_write_the_walk_cannot_read_fails_by_file_and_line(self, tmp_path):
        root = self._tree(tmp_path, (
            "def hold(app_id, update, key):\n"
            "    applications_collection.update_one({}, update)\n"
            "    applications_collection.update_one({}, {'$unset': dict(_UNSET)})\n"
            "    applications_collection.update_one({}, {key: 1})\n"
            "    applications_collection.update_one({})\n"
            "    applications_collection.bulk_write([])\n"))

        assert [failure.split(": the walk")[0]
                for failure in unexcused(root, {("api.planted", "hold"): "a reason"})] == [
            "api/planted.py:2", "api/planted.py:3", "api/planted.py:4", "api/planted.py:5",
            "api/planted.py:6"]
        assert all("cannot read what" in failure
                   for failure in unexcused(root, {("api.planted", "hold"): "a reason"}))

    def test_a_delete_is_listed_but_writes_no_field(self, tmp_path):
        root = self._tree(tmp_path, (
            "def drop(app_id):\n"
            "    applications_collection.delete_one({'id': app_id, 'status': 'open'})\n"))

        assert [failure.split(":")[1] for failure in unexcused(root, {})] == ["2"]
        assert unexcused(root, {("api.planted", "drop"): "a reason"}) == []

    def test_a_migration_is_listed_but_not_read(self, tmp_path):
        root = self._tree(tmp_path, "")
        (tmp_path / "migrations").mkdir()
        (tmp_path / "migrations" / "migrate_x.py").write_text(
            "def migrate(db):\n"
            "    applications = db['applications']\n"
            "    applications.update_one({}, {'$set': {'status': 'open'}})\n")

        assert [failure.split(":")[0] for failure in unexcused(root, {})] == [
            "migrations/migrate_x.py"]
        assert unexcused(root, {("migrations.migrate_x", "migrate"): "a reason"}) == []

    def test_every_way_of_naming_the_applications_collection_is_found(self, tmp_path):
        root = self._tree(tmp_path, (
            "class Store:\n"
            "    def write(self):\n"
            "        ApplicationsApi.applications_collection.find_one_and_update({}, {})\n"
            "        applications.delete_many({})\n"
            "        db['applications'].insert_one({})\n"
            "        get_database()[APPLICATIONS_COLLECTION].replace_one({}, {})\n"
            "        self.applications.bulk_write([])\n"))

        assert [failure.split(":")[1] for failure in unexcused(root, {})] == [
            "3", "4", "5", "6", "7"]
        assert all("in Store.write," in failure for failure in unexcused(root, {}))

    def test_a_write_to_another_collection_passes(self, tmp_path):
        root = self._tree(tmp_path, (
            "def apply():\n"
            "    markets_collection.update_one({}, {'$set': {'status': 'open'}})\n"
            "    db['users'].insert_one({'status': 1})\n"
            "    db[SCHEMA_COLLECTION].update_one({}, {})\n"))

        assert unexcused(root, {}) == []

    def test_a_receiver_it_cannot_name_fails_it_by_file_and_line(self, tmp_path):
        root = self._tree(tmp_path, (
            "def write(name):\n"
            "    _collection().update_one({}, {})\n"
            "    db[name].delete_many({})\n"))

        assert unexcused(root, {}) == [
            "api/planted.py:2: the walk cannot name the receiver of update_one in write; name "
            "the collection, or list the site with its reason",
            "api/planted.py:3: the walk cannot name the receiver of delete_many in write; name "
            "the collection, or list the site with its reason"]

    def test_a_virtual_environment_under_the_back_end_is_not_walked(self, tmp_path):
        root = self._tree(tmp_path, "")
        for package in (".venv/lib/python3.12/site-packages/pymongo", "venv/lib/site-packages/x"):
            (tmp_path / package).mkdir(parents=True)
            (tmp_path / package / "collection.py").write_text(
                "def update_one(self):\n    self.applications.update_one({}, {})\n")

        assert unexcused(root, {}) == []

    def test_the_tests_are_not_walked_and_the_owner_needs_no_reason(self, tmp_path):
        root = self._tree(tmp_path, "")
        (tmp_path / "application_status.py").write_text(
            "def approve():\n"
            "    ApplicationsApi.applications_collection.update_one({}, {'$set': {'status': 1}})\n")

        assert unexcused(root, {}) == []
