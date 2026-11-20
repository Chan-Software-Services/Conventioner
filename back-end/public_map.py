"""The public map: each market day's tables and who is at them, for anyone (T422, ADR 0035).

**The settings are the Public map card's** (``PUT /markets/<id>/public-map``): whether the map is on,
and which of the market's own short text questions hold each vendor's public name, website and
Instagram handle; the public name may also be the built-in business name every form asks (T502,
ADR 0042). Their write asks the table's "Publish the map" row (an Admin's by default, D25),
loads through ``_market_change`` so an archived market refuses it, writes through the market write
holding the settings as read, and records what changed in the market's history through the asking
that let it through, each question by its key and its label, as Discord's question is. A write
that changes nothing writes and records nothing.

**The read is public** (``GET /public/markets/<slug>/map``), behind one gate
(``market_documents.public_map_market_by_slug``, D30): found by its slug as the vendor page finds
it, not archived, its results out, the switch on, its name question the built-in business name or
still a short text question of the form, and at least one location laid out
(``mapped_locations``). A market that fails it answers
exactly as a slug naming no market. What it answers is an allowlist (D26), built key by key here and
never from a dump: the market's name and dates, its table types, each laid-out location's sections
and layout, and each seat with the vendor's three chosen answers cleaned (``public_answers``, D28),
read as the organizer reads them (``effective_answers``, D29). A vendor's address joins a seat to its
application here and is never in the answer.

**The image is public too** (``GET /public/markets/<slug>/map/image/<location_id>``, D33), behind the
same gate: the layout's image found by the location the map lists, never by an id the request names.
"""
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import api.applications as ApplicationsApi
import api.market_actions as Actions
import api.markets as MarketsApi
import essential_fields as EssentialFields
import history as History
import public_answers as PublicAnswers
from assignment.utils import convert_keys_to_camel_case
from client_errors import BadRequestError
from datatypes import (
    FULL_TABLE, HALF_TABLE_LEFT, HALF_TABLE_RIGHT, FloorplanObject, FloorplanTable, LocationObject,
    Market, PublicMapSettings, SectionObject, SetupObject, table_code_for, table_code_sort_key,
)
from market_documents import market_doc_key, public_map_market_by_slug
from market_write import write_market
from utils.email_address import normalized_email

#: The settings a body may carry, by its spelling, each question beside the field it is stored as.
QUESTION_FIELDS = {
    "nameQuestion": "name_question",
    "websiteQuestion": "website_question",
    "instagramQuestion": "instagram_question",
}
SETTINGS_FIELDS = ("enabled", *QUESTION_FIELDS)
NAME_QUESTION = "name_question"

NOT_A_SWITCH = "enabled must be true or false."
NOT_A_TEXT_QUESTION = "Choose one of the form's short text questions."
NO_NAME_QUESTION = (
    "Choose the question that holds each vendor's public name before turning the public map on."
)

#: How long a reader may keep the map's answer and its image (D34).
MAP_CACHE_CONTROL = "public, max-age=60"
IMAGE_CACHE_CONTROL = "public, max-age=300"

#: Each seat a table holds as the map draws it, from the assignment's own spelling.
HALVES = {FULL_TABLE: "whole", HALF_TABLE_LEFT: "left", HALF_TABLE_RIGHT: "right"}
_HALF_ORDER = {"whole": 0, "left": 0, "right": 1}


def _not_a_setting(fields: List[str]) -> str:
    return (f"The public map's settings are {', '.join(SETTINGS_FIELDS)}; "
            f"it does not take {', '.join(fields)}.")


def _not_a_question_value(field: str) -> str:
    return f"{field} must be a question's key or null."


# ── The settings ──────────────────────────────────────────────────────────────

def text_questions(market: Market) -> Dict[str, str]:
    """The form's short text questions, each key by its label, in the form's order."""
    form = market.application_form
    return {field.key: field.label for field in (form.fields if form else [])
            if field.type == "text"}


def name_questions(market: Market) -> Dict[str, str]:
    """What the public name may be read from, each key by its label: the built-in business name
    first, which every form asks, then the form's short text questions (T502, ADR 0042)."""
    return {EssentialFields.BUSINESS_NAME_KEY: EssentialFields.BUSINESS_NAME_LABEL,
            **text_questions(market)}


def offered_questions(market: Market, field: str) -> Dict[str, str]:
    """The questions a setting may name, each key by its label: the website and the Instagram
    handle are the form's short text questions only, the name may be the built-in one too."""
    return name_questions(market) if field == NAME_QUESTION else text_questions(market)


def chosen_question(market: Market, field: str, key: Optional[str]) -> Optional[str]:
    """``key`` while the setting ``field`` may still name it, else None: a question the form lost
    since it was chosen reads as not chosen."""
    return key if key and key in offered_questions(market, field) else None


def settings_of(market: Market) -> PublicMapSettings:
    """The market's settings as stored, or off with nothing chosen for one never set."""
    return market.public_map or PublicMapSettings()


def served(settings: PublicMapSettings) -> Dict[str, Any]:
    """The settings as the write answers them, and the market read serves them."""
    return convert_keys_to_camel_case(settings.model_dump())


def save_settings(market_id: str, body: Dict[str, Any], requesting_user: str) -> Dict[str, Any]:
    """Change what the public map shows, or turn it on or off; answers the settings as stored.

    Raises:
        BadRequestError: a key that is no setting, a switch that is no boolean, a question that is
            no short text question of the form, or a map on with no name question.
        MarketChanged: the market moved, or its settings changed, since they were read.
    """
    change = MarketsApi._market_change(market_id, requesting_user, Actions.PUBLISH_MAP)
    market = change.market
    before = settings_of(market)
    after = before.model_copy(update=_settings_update(market, body))
    if after.enabled and chosen_question(market, NAME_QUESTION, after.name_question) is None:
        raise BadRequestError(NO_NAME_QUESTION)
    if after == before:
        return {"publicMap": served(before)}
    # Written whole and held whole: a product-made market stores ``publicMap: null``, under which
    # no field can be created, and two tabs changing the settings at once never merge their halves.
    write_market(market, {"$set": {market_doc_key("public_map"): served(after)}},
                 holds=(market_doc_key("public_map"),))
    change.asked.record(kind=History.PUBLIC_MAP,
                        detail=lambda: History.changes(_recorded(market, before),
                                                       _recorded(market, after)))
    return {"publicMap": served(after)}


def _settings_update(market: Market, body: Dict[str, Any]) -> Dict[str, Any]:
    """The settings a body changes, each judged as it is read; a key that is none is refused by
    its name, never stored or queried."""
    extra = sorted(set(body) - set(SETTINGS_FIELDS))
    if extra:
        raise BadRequestError(_not_a_setting(extra))
    update: Dict[str, Any] = {}
    if "enabled" in body:
        if not isinstance(body["enabled"], bool):
            raise BadRequestError(NOT_A_SWITCH)
        update["enabled"] = body["enabled"]
    for sent, field in QUESTION_FIELDS.items():
        if sent not in body:
            continue
        key = body[sent]
        if key is not None and not isinstance(key, str):
            raise BadRequestError(_not_a_question_value(sent))
        if key and chosen_question(market, field, key) is None:
            raise BadRequestError(NOT_A_TEXT_QUESTION)
        update[field] = key or None
    return update


def _recorded(market: Market, settings: PublicMapSettings) -> Dict[str, Any]:
    """The settings as the history keeps them: each question by its label as well as its key,
    since the history reads it by its label and the form may lose the question later; the
    built-in business name by its own label."""
    labels = {EssentialFields.BUSINESS_NAME_KEY: EssentialFields.BUSINESS_NAME_LABEL,
              **{field.key: field.label for field in (
                  market.application_form.fields if market.application_form else [])}}
    recorded: Dict[str, Any] = {"enabled": settings.enabled}
    for field in QUESTION_FIELDS.values():
        key = getattr(settings, field)
        recorded[field] = key
        recorded[f"{field}_label"] = labels.get(key) if key else None
    return recorded


# ── The gate ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class MappedLocation:
    """A location the map draws: its sections in the plan's order, its layout, and the layout's
    tables the map lists, those in one of its sections with a number."""

    location: LocationObject
    sections: List[SectionObject]
    layout: FloorplanObject
    tables: List[FloorplanTable]


def mapped_locations(plan: Optional[SetupObject]) -> List[MappedLocation]:
    """The plan's locations the map draws, in the plan's order: each whose layout has a scale and
    at least one table in one of the location's sections, numbered."""
    if plan is None:
        return []
    layouts: Dict[str, FloorplanObject] = {}
    for layout in plan.floorplans or []:
        if layout.location_id is not None:
            layouts.setdefault(layout.location_id, layout)
    mapped = []
    for location in plan.locations:
        layout = layouts.get(location.id)
        if layout is None or not layout.scale_px_per_unit or layout.scale_px_per_unit <= 0:
            continue
        sections = [section for section in plan.sections
                    if section.location is not None and section.location.id == location.id]
        section_ids = {section.id for section in sections}
        tables = [table for table in layout.tables
                  if table.section_id in section_ids and table.number is not None]
        if tables:
            mapped.append(MappedLocation(location, sections, layout, tables))
    return mapped


def is_open(market: Market) -> bool:
    """The gate's own conditions, past those of the market's phase and results: the switch on, its
    name question the built-in business name or one the form still asks, and a location laid
    out."""
    settings = settings_of(market)
    return (settings.enabled
            and chosen_question(market, NAME_QUESTION, settings.name_question) is not None
            and bool(mapped_locations(market.setup_object)))


def _open_market(market_slug: str) -> Optional[Market]:
    from db_config import get_database
    return public_map_market_by_slug(get_database()["markets"], market_slug)


# ── The read ──────────────────────────────────────────────────────────────────

def public_map(market_slug: str) -> Optional[Dict[str, Any]]:
    """The map's answer for the market at this slug, or None for one the gate does not serve."""
    market = _open_market(market_slug)
    if market is None:
        return None
    plan = market.setup_object
    mapped = mapped_locations(plan)
    dates = sorted({market_date.date for market_date in plan.market_dates})
    return {
        "marketName": market.name,
        "dates": dates,
        "tableTypes": [
            {"id": kind.id, "name": kind.name, "widthMm": kind.width_mm, "depthMm": kind.depth_mm}
            for kind in plan.table_types
        ],
        "locations": [_location(place) for place in mapped],
        "seats": _seats(market, mapped, dates),
    }


def _location(place: MappedLocation) -> Dict[str, Any]:
    layout = place.layout
    section_ids = {section.id for section in place.sections}
    return {
        "id": place.location.id,
        "name": place.location.name,
        "sections": [{"id": section.id, "name": section.name} for section in place.sections],
        "layout": {
            "id": layout.id,
            "locationId": layout.location_id,
            "imageWidth": layout.image_width,
            "imageHeight": layout.image_height,
            "scalePxPerUnit": layout.scale_px_per_unit,
            "hasImage": bool(layout.image_gridfs_id),
            "tables": [
                {"id": table.id, "sectionId": table.section_id, "number": table.number,
                 "tableTypeId": table.table_type_id, "xMm": table.x_mm, "yMm": table.y_mm,
                 "rotation": table.rotation}
                for table in place.tables
            ],
            "zones": [
                {"id": zone.id, "label": zone.label, "xMm": zone.x_mm, "yMm": zone.y_mm,
                 "widthMm": zone.width_mm, "depthMm": zone.depth_mm, "rotation": zone.rotation}
                for zone in layout.zones
            ],
            "sectionStyles": [
                {"sectionId": style.section_id, "color": style.color,
                 "labelAt": ({"xMm": style.label_at.x_mm, "yMm": style.label_at.y_mm}
                             if style.label_at else None)}
                for style in layout.section_styles if style.section_id in section_ids
            ],
        },
    }


def _seats(market: Market, mapped: List[MappedLocation], dates: List[str]) -> List[Dict[str, Any]]:
    """Each stored seat on a market date at a table the map lists, with its vendor's public answers.

    A seat names its table by its code, which is built from the section's name and the table's
    number as everywhere a seat is matched (``table_code_for``). Ordered by date, the locations'
    order, the table's code as a person counts, then left before right.
    """
    tables: Dict[str, Tuple[int, FloorplanTable]] = {}
    for order, place in enumerate(mapped):
        names = {section.id: section.name for section in place.sections}
        for table in place.tables:
            tables.setdefault(table_code_for(names[table.section_id], table.number),
                              (order, table))
    on_the_map = set(dates)
    rows = [row for row in market.assignment_object.vendor_assignments or []
            if row.date in on_the_map and row.table_code in tables and row.table_choice in HALVES]
    settings = settings_of(market)
    questions = {field: chosen_question(market, field, getattr(settings, field))
                 for field in QUESTION_FIELDS.values()}
    keys = [key for key in questions.values() if key]
    answers = ApplicationsApi.vendor_answers_for_market(market.id, keys) if rows and keys else {}

    def answer(row, field):
        key = questions[field]
        if not key:
            return None
        given = answers.get(normalized_email(row.email), {})
        if key == EssentialFields.BUSINESS_NAME_KEY:
            # The one reader of the built-in key: absent, an organizer's blank update and a value
            # that is no text are each no business name.
            return EssentialFields.business_name(given)
        return given.get(key)

    rows.sort(key=lambda row: (row.date, tables[row.table_code][0],
                               table_code_sort_key(row.table_code),
                               _HALF_ORDER[HALVES[row.table_choice]]))
    return [
        {
            "date": row.date,
            "tableId": tables[row.table_code][1].id,
            "half": HALVES[row.table_choice],
            "name": PublicAnswers.public_name(answer(row, "name_question")),
            "website": PublicAnswers.public_website(answer(row, "website_question")),
            "instagram": PublicAnswers.instagram_handle(answer(row, "instagram_question")),
        }
        for row in rows
    ]


def public_map_image(market_slug: str, location_id: str) -> Optional[Tuple[bytes, str]]:
    """The image of the layout of a location the map lists, and its content type, or None: for a
    market the gate does not serve, a location the map does not list, or a layout with no image.

    The image is the one the layout found names, never one the request names, and only one stored
    for this market.
    """
    from api.floorplans import detect_mimetype
    from services.gridfs_service import get_image, get_image_market_id

    market = _open_market(market_slug)
    if market is None:
        return None
    place = next((place for place in mapped_locations(market.setup_object)
                  if place.location.id == location_id), None)
    image_id = place.layout.image_gridfs_id if place else None
    if not image_id or get_image_market_id(image_id) != market.id:
        return None
    data = get_image(image_id)
    if data is None:
        return None
    return data, detect_mimetype(data)
