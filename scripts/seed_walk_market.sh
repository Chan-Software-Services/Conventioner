#!/usr/bin/env bash
# Seed one full market in its market days, for a walk of the product as it stands on a market day:
# the organizer's screens (Attendance, the vendor drawer, Applications) and the public map.
#
# Run after scripts/seed_fixture.sh, on the same stack, which it takes exactly as that script does,
# by the rule both share, scripts/lib/stack-identity.sh, which says the order it reads and when it
# refuses. It never starts a stack, and it adds to the database rather than emptying it, so it
# refuses a stack that already holds the market: seed_fixture.sh empties it first.
#
# Every write goes through the back end's own API, signed in as the fixture organizer
# (e2e@example.com), as the organizer's screens would make it:
#   - "Example Winter Makers Fair", a Google Form market of three days: today, tomorrow and the
#     day after, each where this machine is, or from SEED_TODAY (YYYY-MM-DD) and the two days after
#     it when that is set, so a walk can be seeded for a day that is not this one;
#   - two halls laid out, each on a floorplan drawn here: Main Hall (Gold, sections A of 16 tables
#     and B of 15) and Lower Hall (Silver, sections C and D of 14 each), with their zones;
#   - 184 made-up vendors read in through the real import from a made-up form export, 150 approved
#     and 34 rejected;
#   - the real solver's run over the two halls, results published, the market in its market days,
#     some of its first day's vendors checked in, and the public map on, showing each vendor's business
#     name, website and Instagram handle.
# Every name, address and answer is made up here; none comes from production or a real export. A
# vendor's given and family names come from the pools of common names of the synthetic Google Form
# exports' generator, back-end/tests/fixtures/synthetic_form_exports.py, which it reads.
#
# Usage: [SEED_TODAY=YYYY-MM-DD] scripts/seed_walk_market.sh [--primary]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_EMAIL="${TEST_EMAIL:-e2e@example.com}"
TEST_PASSWORD="${TEST_PASSWORD:-e2epassword123}"

refuse() {
  echo "seed_walk_market: $1 - refusing to guess which stack to seed." >&2
  echo "  For a stack th-compose.sh started: eval \"\$(scripts/th-compose.sh ports)\" first." >&2
  echo "  In a treehouse worktree: run this from that checkout, with none of them set." >&2
  echo "  For the default stack (the primary checkout's): pass --primary, from that checkout." >&2
  exit 2
}

PRIMARY=false
for arg in "$@"; do
  case "$arg" in
    --primary) PRIMARY=true ;;
    *)
      echo "seed_walk_market: unknown argument: $arg (usage: seed_walk_market.sh [--primary])" >&2
      exit 2
      ;;
  esac
done

# shellcheck source-path=SCRIPTDIR source=lib/stack-identity.sh
source "$SCRIPT_DIR/lib/stack-identity.sh"
stack_identity "$PROJECT_DIR" "$PRIMARY"

cd "$PROJECT_DIR"
if ! "${DOCKER_CMD[@]}" ps --format '{{.Service}}' 2>/dev/null | grep -qx 'backend'; then
  echo "seed_walk_market: the stack's back end is not running - start and seed it first; this script never starts one." >&2
  exit 3
fi

export SEED_PROJECT_DIR="$PROJECT_DIR"
export SEED_BACKEND_URL="https://127.0.0.1:${BACKEND_PORT}"
export SEED_FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"
export SEED_EMAIL="$TEST_EMAIL" SEED_PASSWORD="$TEST_PASSWORD"
export SEED_TODAY="${SEED_TODAY:-$(date +%F)}"

exec python3 -I - <<'PY'
"""The market, written through the API: see the header of seed_walk_market.sh."""
import importlib.util
import json
import os
import random
import ssl
import struct
import sys
import uuid
import zlib
from datetime import date, timedelta
from urllib import error, request
from urllib.parse import quote

BACKEND = os.environ["SEED_BACKEND_URL"]
FRONTEND = os.environ["SEED_FRONTEND_URL"]
EMAIL = os.environ["SEED_EMAIL"]
PASSWORD = os.environ["SEED_PASSWORD"]
TODAY = date.fromisoformat(os.environ["SEED_TODAY"])
DATES = [TODAY + timedelta(days=n) for n in range(3)]
ISO_DATES = [d.isoformat() for d in DATES]

MARKET_NAME = "Example Winter Makers Fair"
APPLICATIONS = 184
REJECTED = 34
CHECKED_IN_SHARE = 0.45
rng = random.Random(461)

CONTEXT = ssl.create_default_context()
CONTEXT.check_hostname = False
CONTEXT.verify_mode = ssl.CERT_NONE
COOKIES = {}


class Refused(Exception):
    pass


def call(method, path, body=None, *, raw=None, content_type=None, ok=(200, 201)):
    data, headers = None, {}
    if raw is not None:
        data, headers["Content-Type"] = raw, content_type
    elif body is not None:
        data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
    if COOKIES:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in COOKIES.items())
    req = request.Request(BACKEND + path, data=data, method=method, headers=headers)
    try:
        with request.urlopen(req, context=CONTEXT, timeout=300) as res:
            status, text, set_cookies = res.status, res.read().decode(), res.headers.get_all("Set-Cookie") or []
    except error.HTTPError as exc:
        status, text, set_cookies = exc.code, exc.read().decode(), exc.headers.get_all("Set-Cookie") or []
    for cookie in set_cookies:
        name, _, rest = cookie.partition("=")
        COOKIES[name.strip()] = rest.split(";", 1)[0]
    if status not in ok:
        raise Refused(f"{method} {path} answered {status}: {text[:600]}")
    return json.loads(text) if text.strip() else {}


def step(text):
    print(f"- {text}", flush=True)


# ── The floorplans: drawn here, walls and doors on a plain floor ─────────────

PX_PER_M = 40


def png(width, height, pixels):
    rows = b"".join(b"\x00" + bytes(pixels[y * width * 3:(y + 1) * width * 3]) for y in range(height))

    def chunk(kind, payload):
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def hall_image(metres_w, metres_h, doors):
    """A hall of the given size: an off-white floor, a faint 5 m grid, walls 0.4 m thick, and each
    door a gap in a wall, given as (wall, from_m, to_m) with wall one of n, s, e, w."""
    width, height = metres_w * PX_PER_M, metres_h * PX_PER_M
    floor, grid, wall = (247, 246, 242), (232, 230, 224), (70, 70, 70)
    pixels = bytearray(bytes(floor) * (width * height))

    def fill(x0, y0, x1, y1, colour):
        x0, x1 = max(0, x0), min(width, x1)
        for y in range(max(0, y0), min(height, y1)):
            start = (y * width + x0) * 3
            pixels[start:start + (x1 - x0) * 3] = bytes(colour) * (x1 - x0)

    step_px = 5 * PX_PER_M
    for x in range(step_px, width, step_px):
        fill(x, 0, x + 1, height, grid)
    for y in range(step_px, height, step_px):
        fill(0, y, width, y + 1, grid)
    t = int(0.4 * PX_PER_M)
    fill(0, 0, width, t, wall)
    fill(0, height - t, width, height, wall)
    fill(0, 0, t, height, wall)
    fill(width - t, 0, width, height, wall)
    for side, start_m, end_m in doors:
        a, b = int(start_m * PX_PER_M), int(end_m * PX_PER_M)
        if side == "n":
            fill(a, 0, b, t, floor)
        elif side == "s":
            fill(a, height - t, b, height, floor)
        elif side == "w":
            fill(0, a, t, b, floor)
        else:
            fill(width - t, a, width, b, floor)
    return png(width, height, pixels), width, height


def upload(market_id, name, image):
    boundary = uuid.uuid4().hex
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"market_id\"\r\n\r\n{market_id}\r\n".encode(),
        (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
         "Content-Type: image/png\r\n\r\n").encode() + image + b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ]
    return call("POST", "/floorplans/upload", raw=b"".join(parts),
                content_type=f"multipart/form-data; boundary={boundary}")


# ── The plan ──────────────────────────────────────────────────────────────────

GOLD, SILVER = {"id": 1, "name": "Gold"}, {"id": 2, "name": "Silver"}
MAIN = {"id": "loc-main-hall", "name": "Main Hall"}
LOWER = {"id": "loc-lower-hall", "name": "Lower Hall"}
SECTIONS = [
    {"id": "sec-a", "name": "A", "location": MAIN, "tier": GOLD, "count": 16},
    {"id": "sec-b", "name": "B", "location": MAIN, "tier": GOLD, "count": 15},
    {"id": "sec-c", "name": "C", "location": LOWER, "tier": SILVER, "count": 14},
    {"id": "sec-d", "name": "D", "location": LOWER, "tier": SILVER, "count": 14},
]
PRICING = {
    "currency": "CAD",
    "halfTablePercent": 50,
    "everyoneElse": [{"tier": "Gold", "cents": 4500}, {"tier": "Silver", "cents": 3500}],
}


def run(section, x0, y0, count, *, down=False, pitch=1830):
    """``count`` six-foot tables touching end to end from the first one's centre, in mm: across the
    hall, or down it turned a quarter."""
    return [{"section": section, "at": (x0, y0 + i * pitch) if down else (x0 + i * pitch, y0),
             "rotation": 90 if down else 0} for i in range(count)]


# Main Hall, 30 m by 20 m: a stage at the north wall, the entrance in the south wall with the
# information desk inside it, section A down the west wall and along a north island, section B
# along a south island and down the east wall, and two pillars between the islands.
MAIN_SIZE = (30, 20)
MAIN_DOORS = [("s", 12, 18), ("e", 15.5, 18)]
MAIN_TABLES = (run("sec-a", 1200, 4400, 7, down=True)
               + run("sec-a", 6000, 8500, 9)
               + run("sec-b", 7000, 12800, 8)
               + run("sec-b", 28800, 4400, 7, down=True))
MAIN_ZONES = [
    {"label": "Stage", "box": (10000, 500, 10000, 3000)},
    {"label": "Information desk", "box": (12000, 16400, 6000, 1300)},
    {"label": "", "box": (5750, 10400, 500, 500)},
    {"label": "", "box": (23750, 10400, 500, 500)},
    {"label": "Entrance", "box": (12000, 18300, 6000, 1300)},
]

# Lower Hall, 26 m by 16 m: two islands of tables back to back, C to the north and D to the south,
# the stairs down from Main Hall in the south-west corner, washrooms and a coffee cart in the east,
# and seating.
LOWER_SIZE = (26, 16)
LOWER_DOORS = [("w", 12, 15.5), ("n", 8, 11)]
LOWER_TABLES = (run("sec-c", 5000, 5000, 7) + run("sec-c", 5000, 5760, 7)
                + run("sec-d", 5000, 10500, 7) + run("sec-d", 5000, 11260, 7))
LOWER_ZONES = [
    {"label": "Stairs", "box": (500, 12000, 3500, 3500)},
    {"label": "Washrooms", "box": (20500, 500, 5000, 3500)},
    {"label": "Coffee cart", "box": (19500, 6000, 3500, 2000)},
    {"label": "Seating", "box": (18500, 10000, 6500, 4500)},
]


def lay_out(market_id, location, size, doors, tables, zones, prefix):
    image, width, height = hall_image(*size, doors)
    uploaded = upload(market_id, f"{prefix}.png", image)
    metres = size[0]
    floorplan = {
        "id": f"fp-{prefix}", "locationId": location["id"], "revision": 0,
        "imageGridfsId": uploaded["gridfs_id"], "imageWidth": uploaded["width"],
        "imageHeight": uploaded["height"], "tables": [], "zones": [], "sectionStyles": [],
        "startingCounts": [],
        "scalePxPerUnit": uploaded["width"] / (metres * 1000),
        "referenceLineStart": [0, uploaded["height"] / 2],
        "referenceLineEnd": [uploaded["width"], uploaded["height"] / 2],
        "referenceLineLengthMm": metres * 1000,
    }
    saved = call("POST", "/floorplans/save-to-market",
                 {"market_id": market_id, "floorplan": floorplan, "revision": 0})["floorplan"]
    market = call("GET", f"/markets/{market_id}")["market"]
    type_id = market["setupObject"]["tableTypes"][0]["id"]
    numbers = {}
    placed = []
    for i, table in enumerate(tables):
        numbers[table["section"]] = numbers.get(table["section"], 0) + 1
        placed.append({"id": f"{prefix}-table-{i + 1}", "sectionId": table["section"],
                       "number": numbers[table["section"]], "tableTypeId": type_id,
                       "xMm": table["at"][0], "yMm": table["at"][1], "rotation": table["rotation"]})
    placed_zones = [{"id": f"{prefix}-zone-{i + 1}", "label": z["label"], "xMm": z["box"][0],
                     "yMm": z["box"][1], "widthMm": z["box"][2], "depthMm": z["box"][3],
                     "rotation": 0} for i, z in enumerate(zones)]
    call("POST", "/floorplans/save-to-market",
         {"market_id": market_id, "floorplan": {**saved, "tables": placed, "zones": placed_zones},
          "revision": saved["revision"]})
    return len(placed), len(placed_zones)


# ── The vendors: made up from parts, seeded so every run makes the same ones ─

def name_pools():
    """The synthetic Google Form exports' pools of given and family names, read from their generator."""
    path = os.path.join(os.environ["SEED_PROJECT_DIR"], "back-end", "tests", "fixtures",
                        "synthetic_form_exports.py")
    spec = importlib.util.spec_from_file_location("synthetic_form_exports", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.GIVEN_NAMES, module.FAMILY_NAMES


# A person's names come from the synthetic Google Form exports' pools of common names (test data), so
# no seeded vendor reads as a real person.
GIVEN_NAMES, FAMILY_NAMES = name_pools()
STEMS = ["Ash", "Briar", "Cinder", "Dapple", "Ember", "Fen", "Gorse", "Hollow", "Ivy", "Juniper",
         "Kestrel", "Lark", "Moss", "Nettle", "Oak", "Pebble", "Quince", "Rook", "Sorrel", "Thistle",
         "Umber", "Vetch", "Willow", "Yarrow", "Bramble", "Clover", "Heron", "Marrow", "Sloe", "Tansy"]
TAILS = ["wick", "mere", "fold", "hythe", "combe", "holt", "croft", "garth", "shaw", "brook"]
CATEGORIES = {
    "Ceramics": ["Ceramics", "Pottery", "Clayworks", "Stoneware"],
    "Jewellery": ["Jewellery", "Metalsmith", "Silverwork", "Adornments"],
    "Art prints and illustration": ["Prints", "Press", "Illustration", "Art Co."],
    "Textiles and knitwear": ["Knits", "Textiles", "Weavery", "Fibre Co."],
    "Candles and soap": ["Candle Co.", "Soapworks", "Apothecary", "Wax & Wick"],
    "Baked goods and preserves": ["Bakehouse", "Preserves", "Pantry", "Confections"],
    "Plants and flowers": ["Plant Co.", "Florals", "Greenhouse", "Botanicals"],
    "Woodwork": ["Woodworks", "Joinery", "Turnery", "Timber Co."],
    "Stationery and paper goods": ["Paper Goods", "Stationery", "Bindery", "Letterpress"],
    "Leather goods": ["Leatherworks", "Saddlery", "Hide & Stitch", "Leather Co."],
}
WHAT_THEY_SELL = {
    "Ceramics": "Wheel-thrown mugs, bowls and planters",
    "Jewellery": "Hand-forged rings, earrings and pendants",
    "Art prints and illustration": "Risograph prints, zines and cards",
    "Textiles and knitwear": "Hand-knit hats, scarves and blankets",
    "Candles and soap": "Soy candles and cold-process soap",
    "Baked goods and preserves": "Shortbread, jams and holiday loaves",
    "Plants and flowers": "Houseplants, dried wreaths and bulbs",
    "Woodwork": "Cutting boards, spoons and small boxes",
    "Stationery and paper goods": "Notebooks, planners and wrapping paper",
    "Leather goods": "Wallets, belts and card holders",
}

HEADERS = ["Timestamp", "Email Address", "Full name", "Preferred name", "Business name",
           "Category", "What do you sell?", "Website", "Instagram handle",
           "Which days can you attend?", "How many days would you like?",
           "Which tiers will you accept?", "Full or half table?", "Rank the sections"]
MAPPING = {
    "submitted_at": 0, "applicant_email": 1, "essential_full_name": 2,
    "essential_preferred_name": 3, "business_name": 4, "category": 5, "what_they_sell": 6,
    "website": 7, "instagram_handle": 8, "essential_available_dates": 9,
    "essential_max_dates": 10, "essential_tier_preference": 11, "essential_table_choice": 12,
    "essential_section_ranking": 13,
}
FIELDS = [
    {"key": "business_name", "label": "Business name", "type": "text", "required": True},
    {"key": "category", "label": "Category", "type": "select", "required": True,
     "options": list(CATEGORIES)},
    {"key": "what_they_sell", "label": "What do you sell?", "type": "text", "required": True},
    {"key": "website", "label": "Website", "type": "text", "required": False},
    {"key": "instagram_handle", "label": "Instagram handle", "type": "text", "required": False},
]


def csv_cell(value):
    text = str(value)
    return f'"{text.replace(chr(34), chr(34) * 2)}"' if any(c in text for c in ',"\n') else text


def day_in_words(d):
    return f"{d.strftime('%A')}, {d.strftime('%B')} {d.day}"


def make_vendors():
    used = set()
    vendors = []
    for n in range(APPLICATIONS):
        while True:
            stem = rng.choice(STEMS) + rng.choice(TAILS)
            category = rng.choice(list(CATEGORIES))
            business = f"{stem} {rng.choice(CATEGORIES[category])}"
            if business not in used:
                used.add(business)
                break
        first, last = rng.choice(GIVEN_NAMES), rng.choice(FAMILY_NAMES)
        slug = stem.lower()
        email = f"{first.lower()}.{last.lower()}{n + 1}@{slug}.example.com"
        roll = rng.random()
        website = (f"https://{slug}.example.com" if roll < 0.55
                   else f"{slug}.example.com/shop" if roll < 0.7 else "")
        # A handle begins with "example", as every fixture's does (test data): the public map links
        # each to Instagram, where a bare word may be a real maker's account.
        handle_roll = rng.random()
        instagram = (f"@example{slug}" if handle_roll < 0.6
                     else f"example{slug}_studio" if handle_roll < 0.8 else "")
        days = sorted(rng.sample(DATES, rng.choice([1, 2, 2, 3, 3, 3])))
        tiers = rng.choices([["Gold"], ["Silver"], ["Gold", "Silver"]], weights=[40, 20, 40])[0]
        choice = rng.choices(["A whole table to myself", "Half a table, shared", "Either is fine"],
                             weights=[55, 30, 15])[0]
        gold_first = ["A", "B"] if rng.random() < 0.5 else ["B", "A"]
        silver = ["C", "D"] if rng.random() < 0.5 else ["D", "C"]
        ranking = gold_first + silver if tiers[0] == "Gold" else silver + gold_first
        vendors.append({
            "n": n + 1, "email": email, "full_name": f"{first} {last}",
            "preferred": first if rng.random() < 0.15 else "",
            "business": business, "category": category, "what": WHAT_THEY_SELL[category],
            "website": website, "instagram": instagram, "days": days,
            "max_days": str(rng.randint(len(days) if len(days) < 3 else 2, len(days))),
            "tiers": tiers, "choice": choice, "ranking": ranking,
        })
    return vendors


def export(vendors):
    lines = [",".join(HEADERS)]
    start = TODAY - timedelta(days=58)
    for v in vendors:
        submitted = start + timedelta(days=min(40, int(v["n"] / 4.6)))
        stamp = f"{submitted:%Y/%m/%d} {9 + v['n'] % 12:02d}:{(v['n'] * 7) % 60:02d}:00"
        row = [stamp, v["email"], v["full_name"], v["preferred"], v["business"], v["category"],
               v["what"], v["website"], v["instagram"],
               ", ".join(day_in_words(d) for d in v["days"]), v["max_days"], ", ".join(v["tiers"]),
               v["choice"], ", ".join(v["ranking"])]
        lines.append(",".join(csv_cell(c) for c in row))
    return "\n".join(lines) + "\n"


def give(market_id, applications, status):
    for i in range(0, len(applications), 50):
        batch = applications[i:i + 50]
        answer = call("POST", f"/markets/{market_id}/applications/verdicts", {
            "status": status,
            "applications": [{"id": a["id"], "seen": {
                "status": a["status"], "verdictAt": a.get("verdictAt"),
                "updatedAt": a.get("updatedAt")}} for a in batch],
        })
        if answer.get("skipped"):
            raise Refused(f"a verdict of {status} was skipped: {answer['skipped'][:3]}")


def main():
    step(f"Signing in as {EMAIL}")
    call("POST", "/login", {"email": EMAIL, "password": PASSWORD})
    orgs = call("GET", "/organizations").get("organizations", [])
    if not orgs:
        raise Refused("the organizer has no organization: run scripts/seed_fixture.sh first")
    if any(m.get("name") == MARKET_NAME for m in call("GET", "/markets").get("markets", [])):
        raise Refused(f"{MARKET_NAME} is already on this stack: run scripts/seed_fixture.sh first, "
                      "which empties its database")

    step(f"Making {MARKET_NAME}, {ISO_DATES[0]} to {ISO_DATES[-1]}")
    created = call("POST", "/markets", {
        "name": MARKET_NAME, "creationDate": f"{TODAY.isoformat()}T00:00:00Z",
        "organizationId": orgs[0]["id"], "intakeMode": "csv",
        "setupObject": {
            "priority": [], "marketDates": [{"date": d} for d in ISO_DATES],
            "tiers": [GOLD, SILVER], "locations": [MAIN, LOWER], "sections": SECTIONS,
            "pricing": PRICING,
            "assignmentOptions": {"maxAssignmentsPerVendor": None,
                                  "maxHalfTableProportionPerSection": None},
        },
    })
    market_id = created["market_id"]

    form = call("GET", f"/markets/{market_id}/application-form")
    call("PUT", f"/markets/{market_id}/application-form", {
        "fields": [{**f, "options": f.get("options", []), "order": i} for i, f in enumerate(FIELDS)],
        "formRevision": form["formRevision"],
    })
    call("PUT", f"/markets/{market_id}/review-highlights",
         {"keys": ["category", "what_they_sell"], "nothingLeadsTheCard": False})
    call("PUT", f"/markets/{market_id}/rejection-rules", {"rules": [], "noAutomaticRejections": True})

    step("Laying out Main Hall and Lower Hall")
    tables, zones = 0, 0
    for args in ((MAIN, MAIN_SIZE, MAIN_DOORS, MAIN_TABLES, MAIN_ZONES, "main-hall"),
                 (LOWER, LOWER_SIZE, LOWER_DOORS, LOWER_TABLES, LOWER_ZONES, "lower-hall")):
        t, z = lay_out(market_id, *args)
        tables, zones = tables + t, zones + z

    vendors = make_vendors()
    step(f"Importing {len(vendors)} applications from a made-up form export")
    imported = call("POST", f"/markets/{market_id}/applications/import",
                    {"csvContent": export(vendors), "mapping": MAPPING})
    if imported.get("failures") or imported.get("created") != len(vendors):
        raise Refused(f"the import did not take every row: {json.dumps(imported)[:1500]}")

    listed = call("GET", f"/markets/{market_id}/applications")["applications"]
    by_email = {a["applicantEmail"]: a for a in listed}
    in_order = [by_email[v["email"]] for v in vendors]
    rejected_at = set(rng.sample(range(len(vendors)), REJECTED))
    step(f"Approving {len(vendors) - REJECTED} and rejecting {REJECTED}")
    give(market_id, [a for i, a in enumerate(in_order) if i in rejected_at], "reviewer_rejected")
    give(market_id, [a for i, a in enumerate(in_order) if i not in rejected_at], "reviewer_approved")

    step("Allocating tables with the solver, publishing results, opening the market days")
    call("POST", f"/markets/{market_id}/transition", {"toPhase": "assignment"})
    ran = call("POST", f"/markets/{market_id}/assignment")
    call("POST", f"/markets/{market_id}/publish-results")
    call("POST", f"/markets/{market_id}/transition", {"toPhase": "market_days"})

    step("Turning the public map on")
    call("PUT", f"/markets/{market_id}/public-map", {
        "enabled": True, "nameQuestion": "business_name", "websiteQuestion": "website",
        "instagramQuestion": "instagram_handle"})

    market = call("GET", f"/markets/{market_id}")["market"]
    seats = market["assignmentObject"]["vendorAssignments"]
    today_seated = sorted({s["email"] for s in seats if s["date"] == ISO_DATES[0]})
    checked_in = rng.sample(today_seated, int(len(today_seated) * CHECKED_IN_SHARE))
    step(f"Checking in {len(checked_in)} of today's {len(today_seated)} vendors")
    for email in checked_in:
        call("POST", f"/markets/{market_id}/attendance", {"vendorEmail": email, "date": ISO_DATES[0]})

    statuses = {}
    for a in call("GET", f"/markets/{market_id}/applications")["applications"]:
        statuses[a["status"]] = statuses.get(a["status"], 0) + 1
    per_day = {}
    for d in ISO_DATES:
        day = [s for s in seats if s["date"] == d]
        halves = [s for s in day if "Half" in s.get("tableChoice", "")]
        per_day[d] = {"vendors": len({s["email"] for s in day}),
                      "tablesUsed": len({(s.get("location"), s["tableCode"]) for s in day}),
                      "halfSeats": len(halves),
                      "tablesSplitInHalves": len({(s.get("location"), s["tableCode"]) for s in halves})}
    placed = {s["email"] for s in seats}
    slug = market.get("slug") or market.get("marketSlug")
    summary = {
        "market": MARKET_NAME, "marketId": market_id, "slug": slug, "phase": market.get("phase"),
        "dates": ISO_DATES, "applications": len(vendors), "applicationsByStatus": statuses,
        "vendorsApproved": len(vendors) - REJECTED, "vendorsPlacedOnSomeDay": len(placed),
        "approvedButUnplaced": len(vendors) - REJECTED - len(placed),
        "tables": tables, "tablesBySection": {s["name"]: s["count"] for s in SECTIONS},
        "zones": zones, "seatsByDay": per_day, "checkedInToday": len(checked_in),
    }
    print(json.dumps(summary, indent=2))
    print()
    print(f"Organizer:   {FRONTEND}/login  ({EMAIL} / {PASSWORD})")
    if slug:
        print(f"Market page: {FRONTEND}/{slug}")
        print(f"Vendor page: {FRONTEND}/{slug}/vendor")


if __name__ == "__main__":
    try:
        main()
    except Refused as exc:
        print(f"seed_walk_market: {exc}", file=sys.stderr)
        sys.exit(1)
PY
