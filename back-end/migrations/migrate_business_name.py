#!/usr/bin/env python3
"""Move one market's own business name question to the built-in business name (T502, ADR 0042).

Every form now asks a built-in, optional "Business name" (``essential_business_name``), which the
door shows under a vendor's name. A market whose form asked for one as a short text question of
its own keeps its vendors' answers under that question's key, where the door does not read them.
This script moves them, for one market and one question key the operator types: never a label,
never a guess.

**It lists first.** ``--list`` reads every live market and prints, for each short text question
(``type == "text"``) whose key or label holds "business" in any case: the market's id, name, phase
and intake mode, the question's key and label, how many applications answered it, how many already
hold a built-in business name, and what else names the question, and says so where a run that moves
the question is refused until the market's applications stage is over. It writes nothing, prints no
answer and no address, and says so in its last line.

**A run writes in three steps, in this order, each safe to repeat:**

1. **Copy, per application**: where its own answer under the question gives a business name and it
   holds none under the built-in key, ``form_data.essential_business_name`` is set to it, stripped;
   where it holds an organizer's update of the question and none of the built-in, that update is set
   as ``answer_updates.essential_business_name``, its ``by`` and ``at`` as they were, its ``value``
   and ``over`` as the built-in stores them (stripped, an empty or none-word value ``""``, an
   ``over`` that gives no business name ``None``), so "their answer changed since" reads as it read
   before. An update whose value is the business name the vendor's own answer gives is not copied,
   as Update info would not store it, and step 3 removes it. An answer that is blank, or exactly one
   of ``essential_fields.NONE_WORDS`` ("N/A", "none" and the rest, in any capitals, T502), is no
   business name and is not copied; "N/A Studios" is. An application already holding a different
   built-in business name keeps it, and an organizer's update of the question moves beside it all
   the same, its ``over`` the old answer as the built-in stores it, so it reads as made over another
   answer; the run prints these applications' ids and counts them. Each write is held to the answers
   it read, so a vendor's save landing first is left for a second run.
2. **The market, one write** (``write_market``), holding ``formRevision`` (counted up, as a form
   save counts it), the assignment's ``revision`` and ``madeFrom``, and every other part it reads or
   writes, as read: the question leaves ``applicationForm.fields``, the rest stored as every form
   writer stores them (``_normalized_application_form``), each ``order`` its position;
   ``publicMap.nameQuestion`` naming it names ``essential_business_name``; its key in
   ``reviewHighlights`` is replaced in place (dropped where the built-in is listed already); its
   entry in ``importMapping.targets`` and in ``importMapping.resolutions`` moves to the built-in
   key, so the next import maps that column to it; its ``exampleColumns`` entry is removed, so the
   form builder does not offer the column again; and ``assignmentObject.madeFrom.applications`` is
   carried over to the fingerprint of the applications without the moved answer only where it
   matched them as read (``assignment.made_from.applications_now``), so an allocation that read as
   current does again once step 3 is done, and one that did not is left. It records one entry in the
   market's history right after: a form change with no actor (``form``, under Change the form), the
   detail a form save records.
3. **Clean, per application**: ``form_data.<key>`` and ``answer_updates.<key>`` are unset where
   step 1 has nothing left to copy, each write held to the answers it read; an application whose
   answer changed since step 1 is left with it, and counted, for a second run.

It touches nothing the review state owns: no status, no verdict, no ``updated_at``. A vendor's save
and an import, though, build the answers from the form as the market asks it then and compare them
whole to what is stored, so from step 1 until step 3 is done either reads a moved answer as changed
and sends a verdict back to open, and an import of the same file before step 2 also removes the
copies step 1 made. And a vendor's save holds no form revision, so one from a page opened before the
run sends the old question's answer, which the form no longer keeps, and a blank built-in field: the
business name is stored nowhere. So a run that moves the question waits for the applications stage
to be over on a market whose vendors apply on its page, and a run left after step 1 or step 2 is
finished before any import of that market. A market moved back into the applications stage after a
run can still lose a business name that way, from a page a vendor opened before the run.

**It refuses**, writing nothing and exiting 1, when: no live market has the id (none, or it is being
deleted); the market's vendors apply on its page and it is in its applications stage, taking
applications or stopped (run it once the stage is over; a finishing run is let through, since it
only copies what is left and clears the old key, which ends the state in which every save reads as
changed); the key is under the ``essential_`` prefix; the question is not a short text question; the
public map's website or Instagram question, Discord's username question, a priority rule, a price
group's condition or a rejection rule names it (each refusal names which); or the saved import
mapping already maps a column to the built-in key. When the market changed between the read and step
2's write (an organizer's form save, an import, another run), or was deleted then, the market is
left as it was and nothing is recorded or cleaned; the copies step 1 made stay, the vendors' lines
at the door, the command says it stopped after step 1 and exits 1, and a second run on a market
still there finds them already copied.

**A second run** after a run cut before step 2's write finds the question still on the form and runs
whole again, finding step 1's copies already made. Once step 2 has written it finds the question
gone from the form: with no application holding an answer or an update under the key it says the
market is already migrated, writes nothing and exits 0; with some still holding one (a run cut
after step 2, or a vendor's save during it) it says it is finishing a run, and does steps 1 and 3
alone. So a run cut anywhere is finished by running it again with the same arguments, but for the
history entry of a run cut between step 2's write and its entry, which no later run records. A
key never asked reads as already migrated: ``--list`` first.

**It is forward-only.** An older build ignores the built-in key, so a rollback of the code after a
run leaves the business names stored and unshown until a build with the field is promoted again.
Run it after the deploy, while no import of that market is under way; an organizer with the form
editor open (a draft only) is refused their next save and reads the form again.

It prints ids, keys, labels and counts: never a vendor's answer, name or address.

Usage (the production database address passed inline, never from back-end/.env):
    MONGODB_URI='<URI>' python migrations/migrate_business_name.py --list
    MONGODB_URI='<URI>' python migrations/migrate_business_name.py \\
        --market <market-id> --question <key> --dry-run
    MONGODB_URI='<URI>' python migrations/migrate_business_name.py \\
        --market <market-id> --question <key>
"""
import os
import sys
from typing import Any, Dict, List, Mapping, NamedTuple, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pydantic import ValidationError  # noqa: E402

import api.applications as ApplicationsApi  # noqa: E402
import api.market_actions as Actions  # noqa: E402
import api.markets as MarketsApi  # noqa: E402
import essential_fields as EF  # noqa: E402
import history as History  # noqa: E402
import market_write as MarketWrite  # noqa: E402
import rejection_rules as RejectionRules  # noqa: E402
from assignment.made_from import applications_now  # noqa: E402
from assignment.utils import convert_keys_to_camel_case  # noqa: E402
from client_errors import BadRequestError  # noqa: E402
from datatypes import (  # noqa: E402
    IntakeMode, MarketPhase, intake_mode_from_market_document, phase_from_market_document)
from market_documents import MARKETS_COLLECTION, market_doc_key, market_from_document  # noqa: E402
from market_write import MarketChanged, MarketNotFoundError, write_market  # noqa: E402
from tombstone import live  # noqa: E402

BUILT_IN = EF.BUSINESS_NAME_KEY
FORM = market_doc_key("application_form")
FIELDS = f"{FORM}.fields"
FORM_REVISION = market_doc_key("form_revision")
PUBLIC_MAP = market_doc_key("public_map")
HIGHLIGHTS = market_doc_key("review_highlights")
MAPPING = market_doc_key("import_mapping")
EXAMPLES = market_doc_key("example_columns")
REJECTION_RULES = market_doc_key("rejection_rules")
DISCORD = market_doc_key("discord")
SETUP = market_doc_key("setup_object")
ASSIGNMENT = market_doc_key("assignment_object")
MADE_FROM = f"{ASSIGNMENT}.madeFrom"
FORM_DATA, UPDATES = "form_data", ApplicationsApi.ANSWER_UPDATES_FIELD

#: Every part of the market the move reads, judges or writes, held at its value as read by the
#: market's one write, so a change to any of them between the read and the write refuses it.
HOLDS = (PUBLIC_MAP, HIGHLIGHTS, MAPPING, EXAMPLES, REJECTION_RULES, f"{DISCORD}.usernameQuestion",
         f"{SETUP}.priority", f"{SETUP}.pricing", f"{ASSIGNMENT}.revision", MADE_FROM)

#: Why the move is recorded under Change the form with no request asking it (``History.unasked``).
MOVE_RECORDS_UNASKED = (
    "an operator's script, run from a shell and never a request: it takes a market's own business "
    "name question off its form, past the form's lock, once its answers are under the built-in "
    "key, and records it as a form save records its change, with no actor")

USAGE = ("usage: migrate_business_name.py --list\n"
         "       migrate_business_name.py --market <market-id> --question <key> [--dry-run]")


class Refused(Exception):
    """Why the move is not made. Nothing was written, but for ``LeftAfterStepOne``'s copies."""


class LeftAfterStepOne(Refused):
    """Why the move stopped after step 1: the market changed under its write, or was deleted.
    Nothing of the market was written and nothing was cleaned; the copies step 1 made stay, as a
    run cut after step 1 leaves them, for a second run to find."""


class Candidate(NamedTuple):
    """One short text question ``--list`` names, and what the operator reads of it."""
    market_id: str
    key: str
    label: str
    answered: int
    built_in: int
    named_by: List[str]


class Moved(NamedTuple):
    """One application's part in a run, judged from it as read."""
    app_id: str
    #: What step 1 sets, and what its write is held to.
    setting: Dict[str, Any]
    held: Dict[str, Any]
    #: Whether it holds an answer or an update under the question, for step 3 to unset.
    holds_old: bool
    #: Whether its answer under the question is blank or a none word, copied as nothing.
    blank: bool
    #: Whether it holds another built-in business name, which it keeps.
    kept: bool


class Move(NamedTuple):
    """One market's move, judged: what each step writes, and what the operator reads of it."""
    #: ``"move"``, ``"finish"`` (the question is off the form, answers are left) or ``"done"``.
    mode: str
    label: str
    applications: List[Moved]
    #: Step 2's ``$set`` and its sentences, and the history entry's detail; empty unless moving.
    setting: Dict[str, Any]
    lines: List[str]
    detail: Optional[Dict[str, Any]]


def _held(doc: Mapping[str, Any], path: str) -> Any:
    """The filter holding ``path`` at its value in ``doc``, or absent when it has none."""
    value: Any = doc
    for part in path.split("."):
        if not isinstance(value, Mapping) or part not in value:
            return {"$exists": False}
        value = value[part]
    return value


def judged_application(doc: Mapping[str, Any], key: str) -> Moved:
    """What a run does with one application, as read."""
    answers = doc.get(FORM_DATA) or {}
    updates = doc.get(UPDATES) or {}
    given = EF.given_business_name(answers.get(key))
    built_in = EF.business_name(answers)
    kept = bool(built_in and given and built_in != given)
    setting: Dict[str, Any] = {}
    if given and not built_in:
        setting[f"{FORM_DATA}.{BUILT_IN}"] = given
    update = updates.get(key)
    if isinstance(update, Mapping) and BUILT_IN not in updates:
        value = EF.given_business_name(update.get("value"))
        if value != (built_in or given):
            setting[f"{UPDATES}.{BUILT_IN}"] = {
                **update, "value": value,
                "over": EF.given_business_name(update.get("over")) or None}
    held = {"id": doc.get("id"), "market_id": doc.get("market_id")}
    for path in (f"{FORM_DATA}.{key}", f"{FORM_DATA}.{BUILT_IN}", f"{UPDATES}.{key}.value",
                 f"{UPDATES}.{key}.at", f"{UPDATES}.{BUILT_IN}"):
        held[path] = _held(doc, path)
    return Moved(app_id=str(doc.get("id")), setting=setting, held=held,
                 holds_old=key in answers or key in updates,
                 blank=key in answers and not given and not kept, kept=kept)


def _renamed(entries: Mapping[str, Any], key: str) -> Dict[str, Any]:
    """``entries`` with ``key`` renamed to the built-in key, in its place."""
    return {BUILT_IN if each == key else each: value for each, value in entries.items()}


def _referrers(document: Mapping[str, Any], key: str) -> List[Tuple[str, bool]]:
    """What names the question beside the form, each as ``(what, whether a run refuses it)``."""
    found: List[Tuple[str, bool]] = []
    public_map = document.get(PUBLIC_MAP) or {}
    if public_map.get("nameQuestion") == key:
        found.append(("the public map's name", False))
    if public_map.get("websiteQuestion") == key:
        found.append(("the public map's website question", True))
    if public_map.get("instagramQuestion") == key:
        found.append(("the public map's Instagram question", True))
    if (document.get(DISCORD) or {}).get("usernameQuestion") == key:
        found.append(("Discord's username question", True))
    setup = document.get(SETUP) or {}
    if any(isinstance(rule, Mapping) and rule.get("target") == key
           for rule in setup.get("priority") or []):
        found.append(("a priority rule", True))
    for group in (setup.get("pricing") or {}).get("groups") or []:
        if any(isinstance(condition, Mapping) and condition.get("key") == key
               for condition in group.get("conditions") or []):
            found.append((f"the price group {group.get('name')!r}", True))
    if any(isinstance(rule, Mapping) and rule.get("key") == key
           for rule in document.get(REJECTION_RULES) or []):
        found.append(("a rejection rule", True))
    if key in (document.get(HIGHLIGHTS) or []):
        found.append(("a review highlight", False))
    if key in ((document.get(MAPPING) or {}).get("targets") or {}):
        found.append(("the saved import mapping", False))
    if any(isinstance(column, Mapping) and column.get("key") == key
           for column in document.get(EXAMPLES) or []):
        found.append(("an example column", False))
    return found


def _parsed(document: Mapping[str, Any]):
    try:
        return market_from_document(dict(document))
    except ValidationError as error:
        raise Refused(
            f"The market does not parse ({error.error_count()} field(s)); the app cannot read it "
            "either.") from error


def _the_markets_part(document: Mapping[str, Any], key: str) -> Tuple[Dict[str, Any], List[str],
                                                                       Dict[str, Any]]:
    """Step 2's ``$set``, the sentences saying what it does, and the history entry's detail."""
    market = _parsed(document)
    stored_form = market.application_form
    try:
        # As every writer of the form stores it, its order the position in the list.
        form = MarketsApi._normalized_application_form(
            stored_form.model_copy(update={"fields": [
                field for field in stored_form.fields if field.key != key]}),
            published_at=stored_form.published_at,
            essential_options=stored_form.essential_options)
    except BadRequestError as error:
        raise Refused(f"The form without the question is not a form the app stores: {error}") \
            from error
    saved = convert_keys_to_camel_case(form.model_dump())
    others = saved["fields"]
    revision = document.get(FORM_REVISION) or 0
    setting: Dict[str, Any] = {FIELDS: saved["fields"]}
    lines = [f"step 2, the market: the question leaves the form and {len(others)} other "
             f"question(s) are renumbered; formRevision {revision} -> {revision + 1}"]

    if (document.get(PUBLIC_MAP) or {}).get("nameQuestion") == key:
        setting[f"{PUBLIC_MAP}.nameQuestion"] = BUILT_IN
        lines.append("the public map's name question: moves to the built-in business name")
    highlights = document.get(HIGHLIGHTS) or []
    if key in highlights:
        moved: List[str] = []
        for each in highlights:
            each = BUILT_IN if each == key else each
            if each not in moved:
                moved.append(each)
        setting[HIGHLIGHTS] = moved
        lines.append("the review highlights: the question's place goes to the built-in")
    mapping = document.get(MAPPING) or {}
    if key in (mapping.get("targets") or {}):
        setting[f"{MAPPING}.targets"] = _renamed(mapping["targets"], key)
        if key in (mapping.get("resolutions") or {}):
            setting[f"{MAPPING}.resolutions"] = _renamed(mapping["resolutions"], key)
        mapped = "its column and resolutions move to the built-in"
    else:
        mapped = "maps no column to the question"
    examples = document.get(EXAMPLES) or []
    kept_examples = [column for column in examples
                     if not (isinstance(column, Mapping) and column.get("key") == key)]
    if len(kept_examples) != len(examples):
        setting[EXAMPLES] = kept_examples
        mapped += "; its example column is removed"
    lines.append(f"the saved import mapping: {mapped}")

    made_from = (document.get(ASSIGNMENT) or {}).get("madeFrom")
    if not isinstance(made_from, Mapping) or "applications" not in made_from:
        record = "none is stored, so none is written"
    elif made_from["applications"] == applications_now(market):
        setting[f"{MADE_FROM}.applications"] = applications_now(market, without=key)
        record = ("carried over to the applications without the moved answer, so the "
                  "allocation stands as it stood once step 3 is done")
    else:
        record = "left as it is, since it already differs from the applications as read"
    lines.append(f"the allocation's record of the applications: {record}")
    lines.append("the market's history: one form change with no actor")

    detail = MarketsApi.form_changes(market, saved)
    return setting, lines, {**(detail or {}), **RejectionRules.Judged().counts()}


#: Why a market in its applications stage whose vendors apply on its page is refused.
IN_THE_STAGE = ("The market is in its applications stage and its vendors apply on its page: a "
                "vendor's save there, from a page opened before the run, would lose the moved "
                "answer or send their verdict back to open. Run it once the stage is over.")


def _in_the_applications_stage(document: Mapping[str, Any]) -> bool:
    """Whether the market's vendors apply on its page and it is in the stage they may save in,
    taking applications or stopped. A save builds its answers from the form as the market asks it
    then, with no form revision to hold, and compares them whole to what is stored: from step 1
    until step 3 is done it reads a moved answer as changed and sends a verdict back to open, and
    a page opened before the run sends the old question's answer, which the form no longer keeps.
    A stop is undone by a click, so only the stage's end is waited for."""
    return (intake_mode_from_market_document(dict(document)) is IntakeMode.FORM
            and phase_from_market_document(dict(document)) is MarketPhase.APPLICATIONS)


def _refuse_a_market_in_the_applications_stage(document: Mapping[str, Any]) -> None:
    if _in_the_applications_stage(document):
        raise Refused(IN_THE_STAGE)


def judged(document: Mapping[str, Any], key: str, applications: List[Mapping[str, Any]]) -> Move:
    """The move of the question ``key`` on the market as read, or ``Refused``."""
    if key.startswith(EF.ESSENTIAL_KEY_PREFIX):
        raise Refused(f"{key!r} is a built-in question's key, not a question of the market's own.")
    fields = (document.get(FORM) or {}).get("fields") or []
    question = next((field for field in fields
                     if isinstance(field, Mapping) and field.get("key") == key), None)
    moved = [judged_application(doc, key) for doc in applications]
    if question is None:
        mode = "finish" if any(each.holds_old for each in moved) else "done"
        return Move(mode=mode, label="", applications=moved, setting={}, lines=[], detail=None)
    _refuse_a_market_in_the_applications_stage(document)

    if question.get("type") != "text":
        raise Refused(f"The question {key!r} is a {question.get('type')} question, not a short "
                      "text question.")
    for what, refuses in _referrers(document, key):
        if refuses:
            raise Refused(f"{what[0].upper()}{what[1:]} names it: change that first.")
    if BUILT_IN in ((document.get(MAPPING) or {}).get("targets") or {}):
        raise Refused("The saved import mapping already maps a column to the built-in business "
                      "name, so the question's column has nowhere to go.")
    setting, lines, detail = _the_markets_part(document, key)
    return Move(mode="move", label=str(question.get("label")), applications=moved,
                setting=setting, lines=lines, detail=detail)


def record_moved(market_id: str, detail: Mapping[str, Any]) -> None:
    """The move's entry in the market's history: a form change, with no actor."""
    History.unasked(market_id, None, Actions.CHANGE_FORM, because=MOVE_RECORDS_UNASKED).record(
        kind=History.FORM, detail=dict(detail))


def copy_answers(applications, moved: List[Moved]) -> List[str]:
    """Step 1: each application's copy, held to its answers as read. The ids of those whose
    answers moved since the read, left for a second run."""
    missed = []
    for each in moved:
        if each.setting and applications.update_one(
                each.held, {"$set": each.setting}).matched_count == 0:
            missed.append(each.app_id)
    return missed


def clean_answers(applications, market_id: str, key: str) -> Tuple[int, List[str]]:
    """Step 3: unset the question's answer and update on each application, read again now, that
    step 1 has nothing left to copy for. How many were cleaned, and the ids of those left."""
    cleaned, left = 0, []
    query = {"market_id": market_id, "$or": [{f"{FORM_DATA}.{key}": {"$exists": True}},
                                            {f"{UPDATES}.{key}": {"$exists": True}}]}
    for doc in applications.find(query):
        now = judged_application(doc, key)
        if now.setting or applications.update_one(now.held, {"$unset": {
                f"{FORM_DATA}.{key}": "", f"{UPDATES}.{key}": ""}}).matched_count == 0:
            left.append(now.app_id)
            continue
        cleaned += 1
    return cleaned, left


def _database(db):
    if db is None:
        from db_config import get_database
        db = get_database()
    if db[MARKETS_COLLECTION] != MarketWrite.markets_collection:
        raise RuntimeError("migrate_business_name reads the markets write_market writes: pass the "
                           "configured database, or none")
    if db[ApplicationsApi.APPLICATIONS_COLLECTION] != ApplicationsApi.applications_collection:
        raise RuntimeError("migrate_business_name reads the applications the applications module "
                           "reads: pass the configured database, or none")
    if not History.records_in(db):
        raise RuntimeError("migrate_business_name records in the history the history module "
                           "writes: pass the configured database, or none")
    return db


def _named_business(field: Any) -> bool:
    return (isinstance(field, Mapping) and field.get("type") == "text"
            and any("business" in str(field.get(part) or "").lower() for part in ("key", "label")))


def listed(db=None) -> List[Candidate]:
    """Print every live market's short text question that may ask a business name. Read only."""
    db = _database(db)
    applications = db[ApplicationsApi.APPLICATIONS_COLLECTION]
    found: List[Candidate] = []
    markets = 0
    for document in db[MARKETS_COLLECTION].find(live({})):
        questions = [field for field in (document.get(FORM) or {}).get("fields") or []
                     if _named_business(field)]
        if not questions:
            continue
        markets += 1
        market_id = str(document.get("id"))
        docs = list(applications.find({"market_id": market_id}))
        print(f'market {market_id} "{document.get("name")}" (phase {document.get("phase")}, '
              f"intake {document.get('intakeMode') or 'csv'})")
        for field in questions:
            key = str(field.get("key"))
            answered = sum(1 for doc in docs
                           if str((doc.get(FORM_DATA) or {}).get(key) or "").strip())
            built_in = sum(1 for doc in docs if EF.business_name(doc.get(FORM_DATA) or {}))
            named_by = [what for what, _refuses in _referrers(document, key)]
            print(f"  - question {key!r} (\"{field.get('label')}\"): {answered} answered, "
                  f"{built_in} hold a built-in business name; also named by: "
                  + (", ".join(named_by) or "nothing")
                  + ("; a run that moves it is refused until the applications stage is over"
                     if _in_the_applications_stage(document) else ""))
            found.append(Candidate(market_id, key, str(field.get("label")), answered, built_in,
                                   named_by))
    print(f"\nlisted {len(found)} question(s) on {markets} market(s): nothing written, and no "
          "answer or address printed.")
    return found


def migrate(market_id: str, key: str, db=None, dry_run: bool = False) -> Move:
    """Move the question ``key`` of the market to the built-in business name, or say what a run
    would write.

    Raises:
        Refused: why not; nothing was written.
        LeftAfterStepOne: the market changed, or was deleted, under step 2's write, after step 1
            copied.
    """
    db = _database(db)
    applications = db[ApplicationsApi.APPLICATIONS_COLLECTION]
    document = db[MARKETS_COLLECTION].find_one(live({"id": market_id}))
    if document is None:
        raise Refused(f"No live market has the id {market_id!r} (none, or it is being deleted).")
    move = judged(document, key, list(applications.find({"market_id": market_id})))

    if move.mode == "done":
        print(f"market {market_id}: already migrated: the form asks no question {key!r} and no "
              "application holds an answer under it. Nothing written.")
        return move
    copies = [each for each in move.applications if f"{FORM_DATA}.{BUILT_IN}" in each.setting]
    updates = [each for each in move.applications if f"{UPDATES}.{BUILT_IN}" in each.setting]
    kept = [each.app_id for each in move.applications if each.kept]
    holding = sum(1 for each in move.applications if each.holds_old)
    if move.mode == "move":
        print(f'market {market_id} "{document.get("name")}": the question {key!r} '
              f'("{move.label}") moves to the built-in business name'
              + (" (dry run: nothing is written)" if dry_run else ""))
    else:
        print(f'market {market_id} "{document.get("name")}": finishing a run: the form no longer '
              f"asks {key!r}, and answers are left under it (steps 1 and 3)"
              + (" (dry run: nothing is written)" if dry_run else ""))
    print(f"  - step 1, copy: {len(copies)} answer(s) and {len(updates)} organizer's update(s) "
          f"to the built-in key; {sum(1 for each in move.applications if each.blank)} blank or "
          f"none, left; {len(kept)} already holding another business name, kept")
    if kept:
        print("  - kept, each holding another built-in business name, any organizer's update of "
              f"the question moved beside it: {', '.join(kept)}")
    for line in move.lines:
        print(f"  - {line}")
    print(f"  - step 3, clean: {holding} application(s) hold an answer or update under {key!r}, "
          "removed")

    if dry_run:
        print("\nwould move the question to the built-in business name.")
        return move
    missed = copy_answers(applications, move.applications)
    if move.mode == "move":
        try:
            write_market(document, {"$set": move.setting}, holds=HOLDS,
                         revisions={FORM_REVISION: document.get(FORM_REVISION)})
        except MarketNotFoundError as error:
            raise LeftAfterStepOne(
                "The market is gone, or being deleted, since it was read, so nothing of it was "
                "written and no answer was cleaned; the business names step 1 copied stay."
            ) from error
        except MarketChanged as error:
            raise LeftAfterStepOne(
                "The market changed between the read and the write, so nothing of it was written "
                "and no answer was cleaned; the business names step 1 copied stay. Run it "
                "again.") from error
        record_moved(market_id, move.detail or {})
    _cleaned, left = clean_answers(applications, market_id, key)
    changed = sorted(set(missed) | set(left))
    if changed:
        print(f"\n{len(changed)} application(s) changed during the run and were left: run it "
              f"again. {', '.join(changed)}")
    print("\nmoved the question to the built-in business name.")
    return move


def main(argv: List[str]) -> int:
    arguments = list(argv)
    if arguments == ["--list"]:
        listed()
        return 0
    dry_run = "--dry-run" in arguments
    arguments = [argument for argument in arguments if argument != "--dry-run"]
    given: Dict[str, str] = {}
    while len(arguments) >= 2 and arguments[0] in ("--market", "--question") \
            and not arguments[1].startswith("--") and arguments[0] not in given:
        given[arguments[0]] = arguments[1]
        arguments = arguments[2:]
    if arguments or set(given) != {"--market", "--question"}:
        print(USAGE, file=sys.stderr)
        return 1
    try:
        migrate(given["--market"], given["--question"], dry_run=dry_run)
    except LeftAfterStepOne as refusal:
        print(f"stopped after step 1: {refusal}", file=sys.stderr)
        return 1
    except Refused as refusal:
        print(f"refused, nothing written: {refusal}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
