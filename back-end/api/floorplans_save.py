"""
Floorplan save-to-market endpoint.
Bridge between floorplan visual placement and the assignment engine.

POST /api/floorplans/save-to-market
  Accepts market_id, a FloorplanObject (a location's layout, T257) and the revision of it the
  caller read. Puts the floorplan in ``setupObject.floorplans`` in the place of the one of its id,
  or adds it as the location's first, and writes the plan through the plan's own writer, which
  derives the sections' counts from it. Sections and locations are Market Setup's: the save never
  writes them.
"""

import logging
import uuid
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, request, jsonify
from flask_login import login_required
from pydantic import ValidationError

from assignment.utils import convert_keys_to_camel_case, convert_keys_to_snake_case
from client_errors import BadRequestError, field_named_copy, parse_failure_detail
from datatypes import (
    AssignmentOptionObject, FloorplanObject, SetupObject, StartingCount, TableTypeObject,
)
import layout as Layout
from market_write import MarketChanged, write_market
from services.gridfs_service import delete_image
from utils.identity import authenticated_email
from utils.request_body import NOT_AN_OBJECT, string_field

import api.markets as MarketsApi
import api.market_actions as Actions
import history as History

logger = logging.getLogger(__name__)

floorplans_save_bp = Blueprint("floorplans_save", __name__)

def _empty_plan() -> SetupObject:
    """The plan Market Setup starts from (``MarketSetupView.vue``), and so the one a floorplan
    saved to a market whose plan was never saved starts from too."""
    return SetupObject(
        priority=[], market_dates=[], tiers=[], locations=[], sections=[],
        assignment_options=AssignmentOptionObject(),
    )


def _not_whole_refusal(
    e: ValidationError, body: Dict[str, Any], plan: Optional[SetupObject],
) -> Optional[str]:
    """For a floorplan refused only for tables' numbers that are no whole number, the numbering
    sentence of the first such table's section (``layout.numbered_to_its_count``); None for any
    other refusal, or a table of no section of the plan's."""
    errors = e.errors()
    if not errors or plan is None or not all(
            len(error["loc"]) == 3 and error["loc"][0] == "tables" and error["loc"][2] == "number"
            for error in errors):
        return None
    tables = body["floorplan"].get("tables")
    table = tables[errors[0]["loc"][1]] if isinstance(tables, list) else None
    section_id = table.get("sectionId") if isinstance(table, dict) else None
    for section in plan.sections:
        if section.id == section_id:
            return Layout.numbered_to_its_count(section.name, section.count)
    return None


def _follows_the_plan(
    stored: Optional[SetupObject], floorplan_id: Any, settled: Optional[str],
) -> bool:
    """Whether the floorplan of this id follows the plan: the stored one's word, or, for one the
    market does not hold, whether it would start past draft."""
    for held in (stored.floorplans if stored else None) or []:
        if held.id == floorplan_id:
            return held.follows_plan
    return settled is not None


def _parsed_floorplan(
    market_id: str, body: Dict[str, Any], follows_plan: bool = False,
    plan: Optional[SetupObject] = None,
) -> FloorplanObject:
    """The floorplan the body carries, parsed as every model write parses, unknown keys dropped.

    Its own id is required, never the model's default: a save replaces the floorplan of the same
    id, so it must be the id the client holds. On a layout that follows the plan (``plan``, the
    stored one) a table's number that is no whole number is refused with its section's numbering
    sentence, as one past its count is.
    """
    try:
        floorplan = FloorplanObject.model_validate(convert_keys_to_snake_case(body["floorplan"]))
    except ValidationError as e:
        logger.warning("Refused a floorplan for market %s: %s", market_id, parse_failure_detail(e))
        numbering = _not_whole_refusal(e, body, plan) if follows_plan else None
        raise BadRequestError(
            numbering or field_named_copy("Invalid floorplan", e)) from e
    given_id = body["floorplan"].get("id")
    if not isinstance(given_id, str) or not given_id.strip():
        raise BadRequestError("A floorplan needs its id.")
    return floorplan


def _with_floorplan(
    floorplans: Optional[List[FloorplanObject]], floorplan: FloorplanObject,
) -> List[FloorplanObject]:
    """The floorplans with this one in the place of the one of its id, or added after them."""
    kept = list(floorplans or [])
    for index, stored in enumerate(kept):
        if stored.id == floorplan.id:
            kept[index] = floorplan
            return kept
    return kept + [floorplan]


#: Why a save is refused when the layout it read is no longer the stored one: another tab or
#: another organizer saved it, or started this location's layout, in between.
STALE_LAYOUT = "This layout changed elsewhere. Reload to see the latest."

#: The table type a market with none gains as its first layout starts: a 6 ft trestle table.
STANDARD_TABLE_TYPE = {"name": "Standard 6 ft", "width_mm": 1830, "depth_mm": 760}


class StaleLayout(Exception):
    """The layout the save read is not the one stored: answered 409 with ``STALE_LAYOUT``."""


def _revision(data: Dict[str, Any]) -> Optional[int]:
    """The revision of the layout the caller read, 0 for a new one; None when it names none."""
    revision = data.get("revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
        return None
    return revision


def _stored_layout(
    stored: Optional[SetupObject], floorplan: FloorplanObject, revision: int,
) -> Optional[FloorplanObject]:
    """The floorplan the save replaces, None for a location's first layout; ``StaleLayout`` when
    the caller read another revision of it, or a new layout's location already has one."""
    floorplans = (stored.floorplans if stored else None) or []
    for held in floorplans:
        if held.id == floorplan.id:
            if held.revision != revision:
                raise StaleLayout()
            return held
    if revision != 0:
        raise StaleLayout()
    if floorplan.location_id is not None and any(
            held.location_id == floorplan.location_id for held in floorplans):
        raise StaleLayout()
    return None


def _started(plan: SetupObject, floorplan: FloorplanObject, settled: bool) -> FloorplanObject:
    """A location's first layout, holding what Section Setup had for each of its sections.

    Started in Draft, its tables are the seats; started past it (``settled``), it follows the plan
    (T422, D21, ADR 0034): it draws the seats Section Setup settled and never counts them. The
    server's word, whatever the body says, kept on every later save.
    """
    counts = [
        StartingCount(section_id=section.id, count=section.count)
        for section in plan.sections
        if section.location is not None and section.location.id == floorplan.location_id
    ]
    return floorplan.model_copy(update={"starting_counts": counts, "follows_plan": settled})


# ── POST /save-to-market ──────────────────────────────────────────────────────

@floorplans_save_bp.route("/save-to-market", methods=["POST"])
@login_required
def save_floorplan_to_market() -> Tuple[Any, int]:
    """Save a location's layout (a floorplan) to a Market's plan.

    **Request body** (JSON)::

        {
            "market_id": "uuid-string",
            "floorplan": { ... FloorplanObject fields, its own id among them ... },
            "revision": 3
        }

    ``revision`` is the stored revision of the layout the caller read, 0 for a new one.

    Algorithm:
      1. Look up the Market document by ``market_id`` (404 if not found, 400 if it does not parse).
      2. Resolve the requesting user from the session and ask the table's Market Setup row
         (``Actions.CHANGE_SETUP``; 403 if not), then the archived rule (403).
      3. Parse the floorplan (400 naming the field, or when it carries no id of its own).
      4. Find the layout it replaces, by id: 409 ``STALE_LAYOUT`` when the stored one is of another
         revision, or, for a new id, when ``revision`` is not 0 or the location has a layout
         already. Past draft (``MarketsApi.setup_lock_reason``) a layout started in Draft that
         changes a seat (a table added, removed, renumbered, of another id, section or type) is
         refused 409 with the setup-settled sentence (``layout.settled_layout_refusal``); where a
         table stands, the zones, the image, the scale and the sections' colours and labels still
         change. A new layout past draft starts, and follows the plan (T422, ADR 0034): its seats
         are the plan's, so its tables are added, removed, renumbered and moved between its
         location's sections in any phase but archived. A layout keeps its location, its starting
         counts and whether it follows the plan (``followsPlan``, whatever the body sends), and
         moves its revision by one; a new one records Section Setup's counts for its location's
         sections, starts at revision 1, follows the plan when it starts past draft, and gives a
         market with no table type "Standard 6 ft".
      5. Write it through ``MarketsApi.prepared_plan`` with those floorplans, the plan write's own
         judge, its tables of a section not its location's in none and of no number
         (``layout.in_its_sections``), so what is stored is a plan that reads, its sections
         counting the layout's tables, held to every rule a plan write is: among them the
         floorplan's bounds (``floorplan_limits``) and its image, which must be one uploaded for
         this market (400 with the sentence for each); then the layout's own rules
         (``layout.layout_refusal``: its location one of the plan's, no two tables of one id, each
         section's tables numbered 1 to N, or once each from 1 to its count on a layout that
         follows the plan, every type the market's, every table inside the floorplan; 400 with the
         sentence). The write goes through ``write_market``, holding the
         phase and the plan's revision as read and counting it, as every write of the plan does
         (T274): a layout, a plan or table types saved since step 1 read the market make it 409
         ``STALE_LAYOUT``. An image the layout no longer names is deleted.

    **Returns** the layout and the plan's sections as stored, so the editor adopts the revision and
    the counts::

        {"floorplan": { ... }, "sections": [ ... ]}
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Request body must be valid JSON"}), 400
    if not isinstance(data, dict):
        return jsonify({"error": NOT_AN_OBJECT}), 400

    market_id = string_field(data, "market_id")
    if not market_id:
        return jsonify({"error": "market_id is required"}), 400
    if not isinstance(data.get("floorplan"), dict):
        return jsonify({"error": "floorplan is required"}), 400
    revision = _revision(data)
    if revision is None:
        return jsonify({"error": "revision is required"}), 400

    # ── 1. Find the market ─────────────────────────────────────────────
    context = MarketsApi.load_market_context(market_id)
    if context is None:
        return jsonify({"error": "Market not found"}), 404
    if context.market is None:
        return jsonify({"error": "Invalid market data"}), 400
    market = context.market

    # ── 2. Permission check ────────────────────────────────────────────
    user_email = authenticated_email()
    refused = Actions.refusal(Actions.CHANGE_SETUP, user_email, market, context.organization)
    if refused:
        return jsonify({"error": refused}), 403
    # It writes the plan, and an archived market's plan is part of its record (bug 30).
    refusal = MarketsApi.archived_refusal(market)
    if refusal:
        return jsonify({"error": refusal}), 403
    # A layout's seats are the sections' counts, which settle on leaving draft (E31/F01/S02);
    # where a table stands does not, so a settled market's save is judged once it is read (step 4).
    settled = MarketsApi.setup_lock_reason(market)

    # ── 3. Parse the floorplan ─────────────────────────────────────────
    stored = market.setup_object
    floorplan = _parsed_floorplan(
        market_id, data, _follows_the_plan(stored, data["floorplan"].get("id"), settled), stored)
    proposed = stored or _empty_plan()

    # ── 4. The layout it replaces, or starts ───────────────────────────
    try:
        held = _stored_layout(stored, floorplan, revision)
    except StaleLayout:
        return jsonify({"error": STALE_LAYOUT}), 409
    table_types = None
    if held is None:
        floorplan = _started(proposed, floorplan, settled is not None)
        if not proposed.table_types:
            table_types = [TableTypeObject(id=str(uuid.uuid4()), **STANDARD_TABLE_TYPE)]
    else:
        floorplan = floorplan.model_copy(update={
            "location_id": held.location_id, "starting_counts": held.starting_counts,
            "follows_plan": held.follows_plan})
    # A table of a section not its location's is stored in none, of no number (T257).
    floorplan = Layout.in_its_sections(
        floorplan.model_copy(update={"revision": revision + 1}), proposed)
    floorplans = _with_floorplan(stored.floorplans if stored else None, floorplan)
    # Past draft a table may move and turn, and the zones, the image, the scale and the sections'
    # colours and labels change, but no seat of a layout started in Draft: a table added, removed,
    # renumbered, of another id, section or type (T257). A layout that follows the plan starts and
    # changes its tables, which draw the plan's seats (T422).
    if settled:
        refused = Layout.settled_layout_refusal(
            stored, proposed.model_copy(update={"floorplans": floorplans}), settled)
        if refused:
            return jsonify({"error": refused}), 409

    # ── 5. Write it through the plan's own writer ──────────────────────
    prepared = MarketsApi.prepared_plan(
        market, {"setupObject": convert_keys_to_camel_case(proposed.model_dump())},
        floorplans=floorplans, table_types=table_types)
    plan = prepared.plan
    refused = Layout.layout_refusal(floorplan, plan)
    if refused:
        raise BadRequestError(refused)
    # Built on the plan as read, so held at its revision as read, and counted, as every write of
    # the plan is (T274): a plan, a layout or the types saved meanwhile refuse this save, and a
    # Market Setup page open from before is told the market changed rather than storing its copy.
    try:
        write_market(market, {"$set": prepared.update},
                     revisions={MarketsApi.PLAN_REVISION_KEY: market.plan_revision})
    except MarketChanged:
        return jsonify({"error": STALE_LAYOUT}), 409
    MarketsApi.release_removed_floorplans(market, prepared.removed_floorplans, user_email)
    if held is not None and held.image_gridfs_id \
            and held.image_gridfs_id != floorplan.image_gridfs_id:
        delete_image(held.image_gridfs_id)
    location = next(
        (place.name for place in plan.locations if place.id == floorplan.location_id), None)
    History.record(
        market_id, user_email, Actions.CHANGE_SETUP, kind=History.FLOORPLAN,
        subject={"floorplan_id": floorplan.id, "location": location},
        detail=lambda: Layout.describe_change(held, floorplan, plan) or None,
    )

    saved = convert_keys_to_camel_case(plan.model_dump())
    return jsonify({
        "floorplan": next(f for f in saved["floorplans"] if f["id"] == floorplan.id),
        "sections": saved["sections"],
    }), 200
