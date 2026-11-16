"""An owed table-day stores its state, and one owner writes it (T335).

Each ``amounts_owed`` record keeps one of four states: it follows the seat (no record at all), an
Admin set an amount, its table was freed, or it was freed and waived by the free's deduction.
``payments.next_owed_state`` is the one table of what each event makes of each state, and
``payments.owed_day_transition`` the one writer, holding the record's ``revision``. The legacy
fields the release before reads are kept beside the state as a mirror, trusted only while they
agree with it.
"""
import logging

import pytest
from pymongo.errors import DuplicateKeyError

import payments as Payments
from payments import (
    FollowsSeat, Freed, FreedSeat, FreedWaived, HandAmount, OwedEvent, OwedEventRefused,
    SetByHand,
)

MARKET = "market-owed"
ANA = "ana@example.com"
DAY = "2099-05-08"
ADMIN = "admin@example.com"
EDITOR = "editor@example.com"
AT = "2099-04-01T10:00:00+00:00"
NOW = "2099-04-02T10:00:00+00:00"

SEAT = Payments.Seat("North Wing 1", "Gold", "Full Table", 3500)
NEW_SEAT = Payments.Seat("Landing 1", "Silver", "Full Table", 3000)
A = HandAmount(1000, ADMIN, AT)
B = HandAmount(500, "other-admin@example.com", AT)
FREED = FreedSeat(SEAT, EDITOR, AT)

#: Every state a stored day may be in, by name.
STATES = {
    "follows_seat": FollowsSeat(),
    "set(a)": SetByHand(A),
    "freed(s, a)": Freed(FREED, A),
    "freed(s, none)": Freed(FREED, None),
    "freed_waived(s, b)": FreedWaived(FREED, EDITOR, AT, B),
    "freed_waived(s, none)": FreedWaived(FREED, EDITOR, AT, None),
}

REFUSED = "refused"


def _set(cents):
    return SetByHand(HandAmount(cents, ADMIN, NOW))


#: The spec's table, (state, event) -> what the event makes of it, for the held-ness the row is
#: about: follows_seat and set on a held day, the freed rows on a day not held.
TABLE = {
    ("follows_seat", OwedEvent.SEATED): FollowsSeat(),
    ("follows_seat", OwedEvent.FREED): Freed(FreedSeat(NEW_SEAT, ADMIN, NOW), None),
    ("follows_seat", OwedEvent.FREED_WITH_DEDUCTION):
        FreedWaived(FreedSeat(NEW_SEAT, ADMIN, NOW), ADMIN, NOW, None),
    ("follows_seat", OwedEvent.DROPPED_BY_RUN): FollowsSeat(),
    ("follows_seat", OwedEvent.ADMIN_SETS): _set(2000),
    ("follows_seat", OwedEvent.ADMIN_CALCULATED): FollowsSeat(),
    ("set(a)", OwedEvent.SEATED): SetByHand(A),
    ("set(a)", OwedEvent.FREED): Freed(FreedSeat(NEW_SEAT, ADMIN, NOW), A),
    ("set(a)", OwedEvent.FREED_WITH_DEDUCTION):
        FreedWaived(FreedSeat(NEW_SEAT, ADMIN, NOW), ADMIN, NOW, A),
    ("set(a)", OwedEvent.DROPPED_BY_RUN): FollowsSeat(),
    ("set(a)", OwedEvent.ADMIN_SETS): _set(2000),
    ("set(a)", OwedEvent.ADMIN_CALCULATED): FollowsSeat(),
    ("freed(s, a)", OwedEvent.SEATED): SetByHand(A),
    ("freed(s, a)", OwedEvent.FREED): REFUSED,
    ("freed(s, a)", OwedEvent.FREED_WITH_DEDUCTION): REFUSED,
    ("freed(s, a)", OwedEvent.DROPPED_BY_RUN): Freed(FREED, A),
    ("freed(s, a)", OwedEvent.ADMIN_SETS): Freed(FREED, HandAmount(2000, ADMIN, NOW)),
    ("freed(s, a)", OwedEvent.ADMIN_CALCULATED): Freed(FREED, None),
    ("freed(s, none)", OwedEvent.SEATED): FollowsSeat(),
    ("freed(s, none)", OwedEvent.FREED): REFUSED,
    ("freed(s, none)", OwedEvent.FREED_WITH_DEDUCTION): FreedWaived(FREED, ADMIN, NOW, None),
    ("freed(s, none)", OwedEvent.DROPPED_BY_RUN): Freed(FREED, None),
    ("freed(s, none)", OwedEvent.ADMIN_SETS): Freed(FREED, HandAmount(2000, ADMIN, NOW)),
    ("freed(s, none)", OwedEvent.ADMIN_CALCULATED): Freed(FREED, None),
    ("freed_waived(s, b)", OwedEvent.SEATED): SetByHand(B),
    ("freed_waived(s, b)", OwedEvent.FREED): REFUSED,
    ("freed_waived(s, b)", OwedEvent.FREED_WITH_DEDUCTION): REFUSED,
    ("freed_waived(s, b)", OwedEvent.DROPPED_BY_RUN): FreedWaived(FREED, EDITOR, AT, B),
    ("freed_waived(s, b)", OwedEvent.ADMIN_SETS): Freed(FREED, HandAmount(2000, ADMIN, NOW)),
    ("freed_waived(s, b)", OwedEvent.ADMIN_CALCULATED): Freed(FREED, None),
    ("freed_waived(s, none)", OwedEvent.SEATED): FollowsSeat(),
    ("freed_waived(s, none)", OwedEvent.FREED): REFUSED,
    ("freed_waived(s, none)", OwedEvent.FREED_WITH_DEDUCTION): REFUSED,
    ("freed_waived(s, none)", OwedEvent.DROPPED_BY_RUN): FreedWaived(FREED, EDITOR, AT, None),
    ("freed_waived(s, none)", OwedEvent.ADMIN_SETS):
        Freed(FREED, HandAmount(2000, ADMIN, NOW)),
    ("freed_waived(s, none)", OwedEvent.ADMIN_CALCULATED): Freed(FREED, None),
}


def _held_for(name):
    return name in ("follows_seat", "set(a)")


def _fire(state, event, held):
    return Payments.next_owed_state(state, event, held=held, cents=2000, seat=NEW_SEAT,
                                    by=ADMIN, at=NOW)


class TestTheTable:
    def test_it_covers_every_state_by_every_event(self):
        assert set(TABLE) == {(name, event) for name in STATES for event in OwedEvent}

    @pytest.mark.parametrize("name, event", sorted(TABLE, key=str), ids=str)
    def test_each_cell(self, name, event):
        expected = TABLE[(name, event)]
        if expected == REFUSED:
            with pytest.raises(OwedEventRefused):
                _fire(STATES[name], event, _held_for(name))
        else:
            assert _fire(STATES[name], event, _held_for(name)) == expected

    @pytest.mark.parametrize("event", [OwedEvent.ADMIN_SETS, OwedEvent.ADMIN_CALCULATED,
                                       OwedEvent.FREED, OwedEvent.FREED_WITH_DEDUCTION])
    def test_an_amount_or_a_free_on_a_day_with_no_line_is_refused(self, event):
        """An Admin's amount on a day not held is the hidden state, so the owner never writes it;
        a free needs a held seat, and the repair a freed line."""
        with pytest.raises(OwedEventRefused):
            _fire(FollowsSeat(), event, held=False)

    @pytest.mark.parametrize("event", [OwedEvent.SEATED, OwedEvent.DROPPED_BY_RUN])
    def test_a_day_not_held_with_no_record_stays_so(self, event):
        assert _fire(FollowsSeat(), event, held=False) == FollowsSeat()

    def test_a_set_on_a_day_not_held_reads_as_following_the_seat_first(self):
        """A set left by a rolled-back release on a day not held is no line, so seating it again
        follows the new seat and an Admin's amount on it is refused."""
        assert _fire(SetByHand(A), OwedEvent.SEATED, held=False) == FollowsSeat()
        with pytest.raises(OwedEventRefused):
            _fire(SetByHand(A), OwedEvent.ADMIN_SETS, held=False)

    @pytest.mark.parametrize("name", ["freed(s, a)", "freed(s, none)", "freed_waived(s, b)",
                                      "freed_waived(s, none)"])
    def test_an_admins_amount_on_a_freed_record_of_a_held_day_keeps_the_freed_seat(self, name):
        """The Admin's request read the seat held, and a free in flight has written its record
        before its seat goes: the amount is kept with the freed seat, which reads as set while the
        seat is held (``on_day``) and as the freed line's once the free lands."""
        assert _fire(STATES[name], OwedEvent.ADMIN_SETS, held=True) == Freed(
            FREED, HandAmount(2000, ADMIN, NOW))
        assert Payments.on_day(Freed(FREED, HandAmount(2000, ADMIN, NOW)), True) == _set(2000)
        assert _fire(STATES[name], OwedEvent.ADMIN_CALCULATED, held=True) == Freed(FREED, None)

    @pytest.mark.parametrize("event, expected", [
        (OwedEvent.SEATED, SetByHand(B)),
        (OwedEvent.DROPPED_BY_RUN, FollowsSeat()),
        (OwedEvent.FREED, Freed(FreedSeat(NEW_SEAT, ADMIN, NOW), B)),
    ])
    def test_a_stopped_frees_record_on_a_held_day_reads_as_the_seat_first(self, event, expected):
        assert _fire(STATES["freed_waived(s, b)"], event, held=True) == expected

    def test_a_free_needs_the_seat_it_frees(self):
        with pytest.raises(ValueError):
            Payments.next_owed_state(FollowsSeat(), OwedEvent.FREED, held=True, by=ADMIN, at=NOW)

    def test_an_amount_set_needs_its_cents(self):
        with pytest.raises(ValueError):
            Payments.next_owed_state(FollowsSeat(), OwedEvent.ADMIN_SETS, held=True, by=ADMIN,
                                     at=NOW)


class TestOnDay:
    @pytest.mark.parametrize("name, held, expected", [
        ("follows_seat", True, FollowsSeat()),
        ("follows_seat", False, FollowsSeat()),
        ("set(a)", True, SetByHand(A)),
        ("set(a)", False, FollowsSeat()),
        ("freed(s, a)", True, SetByHand(A)),
        ("freed(s, a)", False, Freed(FREED, A)),
        ("freed(s, none)", True, FollowsSeat()),
        ("freed(s, none)", False, Freed(FREED, None)),
        ("freed_waived(s, b)", True, SetByHand(B)),
        ("freed_waived(s, b)", False, FreedWaived(FREED, EDITOR, AT, B)),
        ("freed_waived(s, none)", True, FollowsSeat()),
        ("freed_waived(s, none)", False, FreedWaived(FREED, EDITOR, AT, None)),
    ])
    def test_each_state_held_and_not(self, name, held, expected):
        """A freed record on a held day is a free that stopped before its seat went, or a
        seating that stopped before it tidied the day: a held seat always wins (T270)."""
        assert Payments.on_day(STATES[name], held) == expected


def _record(**fields):
    return {"_id": "rec-1", "market_id": MARKET, "vendor_email": ANA, "date": DAY, **fields}


def _stored(state, revision=1):
    return _record(state=state.to_stored(), **Payments.legacy_fields(state), revision=revision)


#: Each shape the release before wrote, with no state, and the state it is read as.
LEGACY_SHAPES = [
    pytest.param({}, FollowsSeat(), id="nothing"),
    pytest.param({"freed": None, "set_by_hand": None}, FollowsSeat(), id="cleared"),
    pytest.param({"set_by_hand": A.to_stored()}, SetByHand(A), id="set by hand"),
    pytest.param({"freed": Payments.legacy_fields(Freed(FREED, None))["freed"]},
                 Freed(FREED, None), id="freed"),
    pytest.param({"freed": Payments.legacy_fields(Freed(FREED, None))["freed"],
                  "set_by_hand": A.to_stored()}, Freed(FREED, A), id="freed with an amount"),
    pytest.param({"freed": Payments.legacy_fields(Freed(FREED, None))["freed"],
                  "set_by_hand": {"cents": 0, "by": EDITOR, "at": AT, "by_free": True,
                                  "replaced": B.to_stored()}},
                 FreedWaived(FREED, EDITOR, AT, B), id="freed and waived over an amount"),
    pytest.param({"freed": Payments.legacy_fields(Freed(FREED, None))["freed"],
                  "set_by_hand": {"cents": 0, "by": EDITOR, "at": AT, "by_free": True}},
                 FreedWaived(FREED, EDITOR, AT, None), id="freed and waived"),
    pytest.param({"freed": None, "set_by_hand": {"cents": 0, "by": EDITOR, "at": AT,
                                                 "by_free": True, "replaced": B.to_stored()}},
                 SetByHand(B), id="a stopped free's zero over an amount"),
    pytest.param({"set_by_hand": {"cents": 0, "by": EDITOR, "at": AT, "by_free": True}},
                 FollowsSeat(), id="a stopped free's zero"),
]


class TestStateOf:
    def test_no_record_follows_the_seat(self):
        assert Payments.state_of(None) == FollowsSeat()

    @pytest.mark.parametrize("name", STATES)
    def test_an_agreeing_state_is_read_as_stored(self, name, caplog):
        with caplog.at_level(logging.WARNING):
            assert Payments.state_of(_stored(STATES[name])) == STATES[name]
        assert caplog.records == []

    @pytest.mark.parametrize("legacy, expected", LEGACY_SHAPES)
    def test_every_legacy_shape_with_no_state(self, legacy, expected, caplog):
        with caplog.at_level(logging.WARNING):
            assert Payments.state_of(_record(**legacy)) == expected
        assert caplog.records == []

    def test_a_state_its_mirror_disagrees_with_is_read_from_the_mirror_and_logged(self, caplog):
        """A rolled-back release writes only the legacy fields: what it wrote is the day's."""
        doc = _stored(Freed(FREED, A))
        doc["set_by_hand"] = None
        doc["freed"] = None

        with caplog.at_level(logging.WARNING):
            assert Payments.state_of(doc) == FollowsSeat()

        [logged] = caplog.records
        assert MARKET in logged.getMessage() and DAY in logged.getMessage()
        assert "rec-1" in logged.getMessage()
        assert ANA not in logged.getMessage()

    def test_a_state_it_cannot_read_is_read_from_the_mirror(self, caplog):
        doc = _record(state={"kind": "something new"}, set_by_hand=A.to_stored())

        with caplog.at_level(logging.WARNING):
            assert Payments.state_of(doc) == SetByHand(A)
        assert ANA not in caplog.text

    def test_it_never_raises(self):
        assert Payments.state_of(_record(freed="not a seat", set_by_hand=7)) == FollowsSeat()


class TestTheMirror:
    @pytest.mark.parametrize("name", STATES)
    def test_legacy_fields_and_derive_from_legacy_are_inverses(self, name):
        state = STATES[name]
        assert Payments.derive_from_legacy(Payments.legacy_fields(state)) == state

    @pytest.mark.parametrize("name", STATES)
    def test_each_state_reads_back_from_what_it_stores(self, name):
        assert Payments.owed_state_from_stored(STATES[name].to_stored()) == STATES[name]

    def test_following_the_seat_stores_nothing(self):
        assert FollowsSeat().to_stored() is None
        assert Payments.legacy_fields(FollowsSeat()) == {"freed": None, "set_by_hand": None}


class TestTheLines:
    """``lines`` is a projection of the day's state and the held seat, on the unchanged wire."""

    def lines(self, held, state):
        seats = {DAY: NEW_SEAT} if held else {}
        kept = {} if state == FollowsSeat() else {DAY: _stored(state)}
        return Payments.lines(seats, kept)

    def test_a_held_day_following_its_seat(self):
        [line] = self.lines(True, FollowsSeat())
        assert line == {
            "date": DAY, "tableCode": "Landing 1", "tier": "Silver", "tableChoice": "Full Table",
            "group": None, "priceCents": 3000, "owedCents": 3000, "owedSetBy": None,
            "owedSetAt": None, "owedByFree": False, "freed": False, "freedAt": None,
            "freedBy": None}

    def test_a_held_day_with_an_amount_set(self):
        [line] = self.lines(True, SetByHand(A))
        assert (line["tableCode"], line["priceCents"], line["owedCents"]) == (
            "Landing 1", 3000, 1000)
        assert (line["owedSetBy"], line["owedSetAt"], line["freed"]) == (ADMIN, AT, False)

    @pytest.mark.parametrize("name", ["freed(s, a)", "freed(s, none)", "freed_waived(s, b)"])
    def test_a_freed_record_on_a_held_day_never_reads_as_freed(self, name):
        [line] = self.lines(True, STATES[name])
        assert (line["freed"], line["owedByFree"], line["tableCode"]) == (False, False, "Landing 1")

    def test_a_freed_day_with_an_amount_set(self):
        [line] = self.lines(False, Freed(FREED, A))
        assert (line["tableCode"], line["priceCents"], line["owedCents"]) == (
            "North Wing 1", 3500, 1000)
        assert (line["owedSetBy"], line["freed"], line["freedBy"], line["freedAt"]) == (
            ADMIN, True, EDITOR, AT)

    def test_a_freed_day_owing_its_seat(self):
        [line] = self.lines(False, Freed(FREED, None))
        assert (line["owedCents"], line["owedSetBy"], line["freed"]) == (3500, None, True)

    def test_a_freed_and_waived_day(self):
        [line] = self.lines(False, FreedWaived(FREED, ADMIN, NOW, B))
        assert (line["owedCents"], line["owedSetBy"], line["owedSetAt"]) == (0, ADMIN, NOW)
        assert (line["owedByFree"], line["freed"], line["freedBy"]) == (True, True, EDITOR)

    def test_a_day_not_held_following_the_seat_has_no_line(self):
        assert self.lines(False, FollowsSeat()) == []

    def test_a_set_on_a_day_not_held_has_no_line_and_is_logged(self, caplog):
        with caplog.at_level(logging.WARNING):
            assert self.lines(False, SetByHand(A)) == []
        [logged] = caplog.records
        assert MARKET in logged.getMessage() and DAY in logged.getMessage()
        assert ANA not in logged.getMessage()


class TestARolledBackReleasesWrites:
    """The release before writes only the legacy fields; each of its writes over a record this
    release stored reads back as the line that release meant (``state_of`` trusts the mirror)."""

    def line(self, doc, held):
        return Payments.lines({DAY: NEW_SEAT} if held else {}, {DAY: doc})

    def test_its_amount_set_by_hand_over_a_freed_line(self):
        doc = _stored(Freed(FREED, None))
        doc["set_by_hand"] = HandAmount(2500, ADMIN, NOW).to_stored()

        [line] = self.line(doc, held=False)
        assert (line["freed"], line["owedCents"], line["owedSetBy"]) == (True, 2500, ADMIN)

    def test_its_free_with_a_deduction_over_an_amount_set(self):
        doc = _stored(SetByHand(A))
        doc["freed"] = Payments.legacy_fields(Freed(FREED, None))["freed"]
        doc["set_by_hand"] = {"cents": 0, "by": EDITOR, "at": NOW, "by_free": True,
                              "replaced": A.to_stored()}

        [line] = self.line(doc, held=False)
        assert (line["freed"], line["owedCents"], line["owedByFree"]) == (True, 0, True)

    def test_its_seating_again_clearing_a_freed_line(self):
        doc = _stored(FreedWaived(FREED, EDITOR, AT, A))
        doc["freed"] = None
        doc["set_by_hand"] = A.to_stored()

        [line] = self.line(doc, held=True)
        assert (line["freed"], line["owedCents"], line["owedSetBy"]) == (False, 1000, ADMIN)

    def test_the_next_write_stores_the_state_again(self, owed):
        doc = _stored(Freed(FREED, None), revision=4)
        doc["set_by_hand"] = HandAmount(2500, ADMIN, NOW).to_stored()
        owed.insert_one(doc)

        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=None,
                                     by=ADMIN, cents=700)

        [stored] = owed.documents
        assert Payments.owed_state_from_stored(stored["state"]) == Freed(
            FREED, HandAmount(700, ADMIN, stored["state"]["amount"]["at"]))
        assert stored["revision"] == 5


# --- The one writer -------------------------------------------------------------------------------

@pytest.fixture
def owed(market_records):
    return market_records.amounts_owed


def _the_record(owed):
    [doc] = owed.documents
    return doc


def _mirror_agrees(doc):
    state = Payments.owed_state_from_stored(doc["state"])
    return {key: doc.get(key) for key in ("freed", "set_by_hand")} == Payments.legacy_fields(state)


class TestTheOwner:
    def test_a_first_write_inserts_the_state_its_mirror_and_revision_one(self, owed):
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                             by=ADMIN, cents=1200)

        doc = _the_record(owed)
        assert doc["state"]["kind"] == "set"
        assert doc["revision"] == 1
        assert _mirror_agrees(doc)
        assert (moved.before, moved.wrote, moved.revision) == (FollowsSeat(), True, 1)
        assert moved.after == Payments.state_of(doc)

    def test_each_write_counts_the_revision_up(self, owed):
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                     by=ADMIN, cents=1200)
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT, seat=SEAT,
                                     by=EDITOR)

        doc = _the_record(owed)
        assert (doc["state"]["kind"], doc["revision"]) == ("freed", 2)
        assert doc["state"]["amount"]["cents"] == 1200
        assert _mirror_agrees(doc)

    def test_following_the_seat_deletes_the_record(self, owed):
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                     by=ADMIN, cents=1200)

        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=SEAT, by=ADMIN)

        assert owed.documents == []
        assert (moved.after, moved.wrote) == (FollowsSeat(), True)

    def test_a_result_that_is_the_stored_state_writes_nothing(self, owed):
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=SEAT, by=ADMIN)

        assert owed.documents == []
        assert (moved.wrote, moved.changed) == (False, False)

    def test_tidying_a_stopped_frees_record_on_a_held_day_changes_nothing_it_reads(self, owed):
        owed.insert_one(_stored(FreedWaived(FREED, EDITOR, AT, None)))

        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=SEAT, by=ADMIN)

        assert (moved.before, moved.wrote, moved.changed) == (FollowsSeat(), True, False)

    @pytest.mark.parametrize("name", ["freed(s, a)", "freed(s, none)", "freed_waived(s, b)",
                                      "freed_waived(s, none)"])
    def test_seating_a_freed_day_again_changes_what_it_reads(self, owed, name):
        """A freed line becomes the held seat's line, so what the day reads as changed."""
        owed.insert_one(_stored(STATES[name]))

        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.SEATED, held=None,
                                             by=ADMIN)

        assert moved.changed is True

    def test_seating_a_held_day_with_an_amount_set_changes_nothing_it_reads(self, owed):
        owed.insert_one(_stored(SetByHand(A)))

        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.SEATED, held=SEAT,
                                             by=ADMIN)

        assert (moved.wrote, moved.changed) == (False, False)

    def test_a_cleared_legacy_record_reading_as_the_seat_is_taken_away(self, owed):
        """The release before cleared a seated-again day's fields and kept the record: it reads
        as following the seat, which is no record, so the next event on it deletes it."""
        owed.insert_one(_record(freed=None, set_by_hand=None))

        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=SEAT, by=ADMIN)

        assert owed.documents == []
        assert (moved.wrote, moved.changed) == (True, False)

    def test_a_disagreeing_mirror_is_logged_once_a_write(self, owed, caplog):
        doc = _stored(Freed(FREED, None))
        doc["freed"] = None
        owed.insert_one(doc)

        with caplog.at_level(logging.WARNING):
            Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                         by=ADMIN, cents=800)

        assert len(caplog.records) == 1
        stored = _the_record(owed)
        assert Payments.state_of(stored) == SetByHand(
            HandAmount(800, ADMIN, stored["state"]["amount"]["at"]))

    def test_a_legacy_record_is_written_holding_its_missing_revision(self, owed):
        owed.insert_one(_record(set_by_hand=A.to_stored()))

        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT, seat=SEAT,
                                     by=EDITOR)

        doc = _the_record(owed)
        assert (doc["state"]["kind"], doc["revision"]) == ("freed", 1)
        assert Payments.state_of(doc) == Freed(FreedSeat(SEAT, EDITOR, doc["freed"]["at"]), A)

    def test_a_refused_event_writes_nothing(self, owed):
        owed.insert_one(_stored(Freed(FREED, None)))

        with pytest.raises(OwedEventRefused):
            Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=None, seat=SEAT,
                                         by=EDITOR)

        assert _the_record(owed)["revision"] == 1

    def test_a_revision_missed_reads_the_day_again(self, owed, monkeypatch):
        """Another write lands between the owner's read and its write: the write misses, and the
        owner reads again and applies the event to what the other wrote."""
        owed.insert_one(_stored(SetByHand(A)))
        read = owed.find_one

        def read_then_another_write(query, *args, **kwargs):
            monkeypatch.setattr(owed, "find_one", read)
            found = read(query, *args, **kwargs)
            Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                         by=ADMIN, cents=4000)
            return found

        monkeypatch.setattr(owed, "find_one", read_then_another_write, raising=False)

        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED_WITH_DEDUCTION, held=SEAT,
                                     seat=SEAT, by=EDITOR)

        state = Payments.state_of(_the_record(owed))
        assert isinstance(state, FreedWaived)
        assert state.before.cents == 4000
        assert _the_record(owed)["revision"] == 3

    def test_a_first_record_created_since_the_read_reads_the_day_again(self, owed, monkeypatch):
        """The unique index refuses an insert on a day given a record since the read."""
        insert = owed.insert_one

        def another_lands_first(document):
            monkeypatch.setattr(owed, "insert_one", insert)
            Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                         by=ADMIN, cents=4000)
            raise DuplicateKeyError("E11000 duplicate key error", code=11000)

        monkeypatch.setattr(owed, "insert_one", another_lands_first, raising=False)

        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT, seat=SEAT,
                                     by=EDITOR)

        doc = _the_record(owed)
        assert (doc["state"]["kind"], doc["state"]["amount"]["cents"], doc["revision"]) == (
            "freed", 4000, 2)

    def test_a_day_that_keeps_changing_raises_having_written_nothing(self, owed, monkeypatch):
        owed.insert_one(_stored(SetByHand(A)))
        read = owed.find_one
        reads = []

        def read_then_moved(query, *args, **kwargs):
            found = read(query, *args, **kwargs)
            reads.append(found["revision"])
            for doc in owed.documents:
                doc["revision"] += 1
            return found

        monkeypatch.setattr(owed, "find_one", read_then_moved, raising=False)

        with pytest.raises(Payments.OwedDayChanged):
            Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT, seat=SEAT,
                                         by=EDITOR)

        assert len(reads) == Payments.OWED_TRIES == 3
        doc = _the_record(owed)
        assert (doc["state"]["kind"], doc["revision"]) == ("set", 4)


class TestUndo:
    def test_it_puts_the_record_back_as_read(self, owed):
        owed.insert_one(_stored(SetByHand(A), revision=3))
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT,
                                             seat=SEAT, by=EDITOR)

        assert moved.undo()

        doc = _the_record(owed)
        assert (Payments.state_of(doc), doc["revision"]) == (SetByHand(A), 3)
        assert _mirror_agrees(doc)

    def test_it_takes_away_a_record_it_made(self, owed):
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT,
                                             seat=SEAT, by=EDITOR)

        assert moved.undo()

        assert owed.documents == []

    def test_it_puts_back_a_legacy_record_without_the_fields_it_lacked(self, owed):
        owed.insert_one(_record(set_by_hand=A.to_stored()))
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT,
                                             seat=SEAT, by=EDITOR)

        assert moved.undo()

        doc = _the_record(owed)
        assert "state" not in doc and "revision" not in doc and "freed" not in doc
        assert doc["set_by_hand"] == A.to_stored()

    def test_it_lands_only_on_its_own_revision(self, owed):
        """A write that landed since owns the day: nothing is put back, and the undo says so."""
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.FREED, held=SEAT,
                                             seat=SEAT, by=EDITOR)
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=None,
                                     by=ADMIN, cents=900)

        assert not moved.undo()

        doc = _the_record(owed)
        assert (doc["state"]["amount"]["cents"], doc["revision"]) == (900, 2)

    def test_it_leaves_a_record_made_since_at_the_revision_it_wrote(self, owed):
        """A run's tidy deleted the record this Admin's amount made, and another Admin's amount
        made a new one, at revision 1 too: that record is another write's, and stays."""
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                             by=ADMIN, cents=0)
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.DROPPED_BY_RUN, held=SEAT,
                                     by=EDITOR)
        Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_SETS, held=SEAT,
                                     by=EDITOR, cents=900)

        assert not moved.undo()

        doc = _the_record(owed)
        assert (doc["state"]["amount"]["cents"], doc["revision"]) == (900, 1)

    def test_one_that_wrote_nothing_does_nothing(self, owed):
        owed.insert_one(_stored(Freed(FREED, None)))
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=None, by=ADMIN)

        assert moved.undo()

        assert _the_record(owed)["revision"] == 1

    def test_one_that_deleted_the_record_is_not_undone(self, owed):
        """Neither caller undoes a write that ends in following the seat, so one that did is a
        caller's mistake, said out loud rather than putting back a record a write may have made
        since."""
        owed.insert_one(_stored(SetByHand(A)))
        moved = Payments.owed_day_transition(MARKET, ANA, DAY, OwedEvent.ADMIN_CALCULATED,
                                             held=SEAT, by=ADMIN)
        assert (moved.wrote, moved.revision) == (True, None)

        with pytest.raises(ValueError):
            moved.undo()

        assert owed.documents == []
