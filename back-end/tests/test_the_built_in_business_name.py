"""Every form asks a built-in business name (T502, ADR 0042).

An organizer at the door finds a vendor by the name on their name tag, and for some that is the
name they trade under. The app kept none of its own: a market that wanted one asked it as a
question of its own form, under a key and a label of its choosing, so no screen could rely on it.
Now every form asks an optional "Business name" right after the preferred name.

It is stored only when one was given. An applicant's save and an import compare the whole stored
answers, so a key every save wrote as ``""`` would make each application written before this one
read as changed, and send a person's approval or rejection back to open on an unchanged file.

The contract is read on its own; the saves, the import and the organizer's update through the
routes, as an applicant and an organizer reach them.
"""
import pytest

from conftest import FakeApplicationsCollection, seen_as_stored
from test_choosing_reviewers_deals_the_open_applications import ADMIN, MARKET, _client
from test_csv_import import GOOD_ROW, HEADERS, MAPPING
from test_csv_import import _market_doc as _import_market_doc
from test_each_arrival_is_dealt import _id_of, _submit, world  # noqa: F401
from test_essential_fields import VALID_ANSWERS

import app as app_module
import api.applications as ApplicationsApi
import api.market_actions as Actions
import csv_import as CsvImport
import essential_fields as EF
import history as History
from datatypes import ApplicationStatus, EssentialFormOptions, FormField, MarketPhase

KEY = EF.BUSINESS_NAME_KEY
VENDOR = "ana@example.com"
EMPTY = EssentialFormOptions(dates=[], sections=[], table_types=[], tiers=[])
NAMED = {EF.FULL_NAME_KEY: "Ana Rivera"}


class TestWhereItSitsInTheContract:
    def test_it_is_asked_right_after_the_preferred_name(self):
        keys = [key for key, _label in EF.ESSENTIAL_QUESTIONS]

        assert keys.index(KEY) == keys.index(EF.PREFERRED_NAME_KEY) + 1
        assert dict(EF.ESSENTIAL_QUESTIONS)[KEY] == "Business name"

    def test_every_form_asks_it_a_market_with_no_plan_included(self):
        assert KEY in EF.asked_essential_keys(EMPTY)

    def test_no_market_may_leave_it_unasked(self):
        assert KEY not in EF.UNASKABLE_ESSENTIAL_KEYS
        assert EF.unaskable_essential_error([KEY]) is not None

    def test_nobody_has_to_answer_it(self):
        assert KEY not in EF.REQUIRED_ESSENTIAL_KEYS

    def test_a_form_asking_only_it_and_the_names_asks_nothing_to_apply_for(self):
        assert KEY not in EF.plan_derived_asked_keys(EMPTY)

    def test_the_assignment_never_reads_it(self):
        assert KEY not in EF.SOLVER_RELEVANT_KEYS

    def test_an_organizer_may_update_it(self):
        assert EF.UPDATABLE_ESSENTIAL_QUESTIONS[KEY] == (KEY,)


class TestAnApplicantsAnswer:
    def _stored(self, **answers):
        error, stored = EF.validated_essential_answers({**NAMED, **answers}, EMPTY)
        assert error is None, error
        return stored

    def test_one_given_is_stored_without_the_space_around_it(self):
        assert self._stored(**{KEY: "  Paper & Pine  "})[KEY] == "Paper & Pine"

    @pytest.mark.parametrize("given", [{}, {KEY: ""}, {KEY: "   "}, {KEY: None}, {KEY: ["Pine"]}])
    def test_none_given_stores_no_key_at_all(self, given):
        stored = self._stored(**given)

        assert KEY not in stored
        # The preferred name beside it keeps its empty string: only this key is absent when empty.
        assert stored[EF.PREFERRED_NAME_KEY] == ""

    def test_no_reason_to_refuse_a_row_ever_names_it(self):
        assert EF.essential_answer_errors({KEY: "   "}, EMPTY) == ["'Full name' is required."]


class TestTheOneReader:
    @pytest.mark.parametrize("answers", [
        {}, {KEY: ""}, {KEY: "   "}, {KEY: None}, {KEY: 7}, {KEY: ["Paper & Pine"]},
    ])
    def test_absent_blank_and_not_text_are_all_none(self, answers):
        assert EF.business_name(answers) == ""

    def test_one_given_reads_without_the_space_around_it(self):
        assert EF.business_name({KEY: " Paper & Pine "}) == "Paper & Pine"

    def test_it_is_never_the_name_a_vendor_is_called_by(self):
        assert EF.display_name({**NAMED, KEY: "Paper & Pine"}) == "Ana Rivera"


class TestAnOrganizersUpdateOfIt:
    def _update(self, current, value):
        error, stored = EF.validated_essential_update(
            {**NAMED, **current}, {KEY: value}, EMPTY, limit_required=False)
        assert error is None, error
        return stored

    def test_one_given_is_stored_without_the_space_around_it(self):
        assert self._update({}, " Pine & Paper ") == {KEY: "Pine & Paper"}

    @pytest.mark.parametrize("blank", ["", "   ", None])
    def test_one_left_blank_is_stored_empty_since_no_key_cannot_say_it_was_removed(self, blank):
        assert self._update({KEY: "Paper & Pine"}, blank) == {KEY: ""}

    def test_it_is_never_refused_for_a_vendor_stored_with_no_name(self):
        error, stored = EF.validated_essential_update(
            {}, {KEY: "Paper & Pine"}, EMPTY, limit_required=False)

        assert (error, stored) == (None, {KEY: "Paper & Pine"})


def _doc(world, app_id):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _save(world, **answers):
    """``VENDOR`` saves their application, as their page sends it."""
    world.vendor = VENDOR
    return app_module.app.test_client().put(
        "/public/markets/test-market/applicant/application",
        json={"formData": {**VALID_ANSWERS, "business_name": VENDOR, **answers}})


def _approve(app_id):
    response = _client(ADMIN).put(
        f"/markets/{MARKET}/applications/{app_id}/review",
        json={"status": "reviewer_approved", "seen": seen_as_stored(app_id)})
    assert response.status_code == 200, response.get_json()


def _edits(world, app_id):
    return [e for e in world.history.documents
            if e["action"] == History.APPLY and e["kind"] == History.EDITED
            and e["subject"]["application_id"] == app_id]


class TestAnApplicantsSave:
    def test_a_business_name_is_stored_under_the_key(self, world):
        assert _save(world, **{KEY: "  Paper & Pine "}).status_code == 200

        assert _doc(world, _id_of(world, VENDOR))["form_data"][KEY] == "Paper & Pine"

    @pytest.mark.parametrize("given", [{}, {KEY: ""}, {KEY: "   "}])
    def test_none_is_accepted_and_stores_no_key(self, world, given):
        response = _save(world, **given)

        assert response.status_code == 200, response.get_json()
        assert KEY not in _doc(world, _id_of(world, VENDOR))["form_data"]

    def test_one_stored_before_the_question_keeps_its_approval_on_the_same_answers(self, world):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)
        # As every application written before the question holds its answers: no such key.
        assert KEY not in _doc(world, app_id)["form_data"]
        _approve(app_id)

        # The new page sends the question it now draws, left empty.
        assert _save(world, **{KEY: ""}).status_code == 200

        assert _doc(world, app_id)["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert _edits(world, app_id) == []

    def test_giving_one_later_is_a_change_like_any_other(self, world):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)
        _approve(app_id)

        assert _save(world, **{KEY: "Paper & Pine"}).status_code == 200

        assert _doc(world, app_id)["status"] == ApplicationStatus.OPEN.value


class TestAnImport:
    def _import(self, row, mapping=MAPPING, headers=HEADERS):
        content = "\n".join([",".join(headers), row])
        response = _client().post(f"/markets/{MARKET}/applications/import",
                                  json={"csvContent": content, "mapping": mapping})
        assert response.status_code == 200, response.get_json()
        return response.get_json()

    def test_it_is_an_optional_target_listed_after_the_preferred_name(self, world):
        targets = CsvImport.import_targets(_import_market_doc())
        keys = [target.key for target in targets]
        target = next(target for target in targets if target.key == KEY)

        assert keys.index(KEY) == keys.index(EF.PREFERRED_NAME_KEY) + 1
        assert (target.label, target.required, target.kind) == (
            "Business name", False, "essential")

    def test_a_column_mapped_to_it_is_stored_and_an_empty_cell_stores_no_key(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        headers = [*HEADERS, "Trading as"]
        mapping = {**MAPPING, KEY: len(HEADERS)}

        self._import(GOOD_ROW + ",Paper & Pine", mapping, headers)
        self._import(GOOD_ROW.replace("nadia@", "theo@") + ",", mapping, headers)

        assert _doc(world, _id_of(world, "nadia@ember.test"))["form_data"][KEY] == "Paper & Pine"
        assert KEY not in _doc(world, _id_of(world, "theo@ember.test"))["form_data"]

    def test_an_unchanged_row_of_one_stored_before_the_question_changes_nobody(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        self._import(GOOD_ROW)
        app_id = _id_of(world, "nadia@ember.test")
        assert KEY not in _doc(world, app_id)["form_data"]
        _approve(app_id)
        before = dict(_doc(world, app_id))

        body = self._import(GOOD_ROW)

        assert (body["unchanged"], body["updated"], body["returnedToReview"]) == (1, 0, 0)
        assert _doc(world, app_id) == before


def _update(app_id, value):
    response = _client(ADMIN).put(f"/markets/{MARKET}/applications/{app_id}/answers",
                                  json={"answers": {KEY: value}})
    assert response.status_code == 200, response.get_json()
    return response.get_json()["application"]


class TestAnOrganizerUpdatingIt:
    def _approved(self, world, **answers):
        _submit(world, VENDOR, **answers)
        app_id = _id_of(world, VENDOR)
        _approve(app_id)
        return app_id

    def test_they_set_change_and_blank_it_and_the_approval_stays(self, world):
        app_id = self._approved(world, **{KEY: "Paper & Pine"})

        for value, reads in [("Paper and Pine", "Paper and Pine"), ("", "")]:
            served = _update(app_id, value)

            doc = _doc(world, app_id)
            assert doc["status"] == ApplicationStatus.REVIEWER_APPROVED.value
            assert doc["answer_updates"][KEY]["value"] == value
            assert doc["answer_updates"][KEY]["over"] == "Paper & Pine"
            # What the vendor wrote is kept, and the organizer reads the update in its place.
            assert doc["form_data"][KEY] == "Paper & Pine"
            assert EF.business_name(ApplicationsApi.effective_answers(doc)) == reads
            assert served["formData"][KEY] == value

    def test_one_set_for_a_vendor_who_gave_none_stands_over_nothing(self, world):
        app_id = self._approved(world)

        _update(app_id, "Paper & Pine")

        update = _doc(world, app_id)["answer_updates"][KEY]
        assert (update["value"], update["over"]) == ("Paper & Pine", None)

    def test_blanking_one_set_for_a_vendor_who_gave_none_takes_the_update_away(self, world):
        app_id = self._approved(world)
        _update(app_id, "Paper & Pine")

        _update(app_id, "")

        assert KEY not in (_doc(world, app_id).get("answer_updates") or {})

    def test_a_blank_restated_after_the_vendor_removed_theirs_takes_the_update_away(self, world):
        """An organizer blanked "Paper & Pine", the vendor then removed their own, and the
        organizer saves the blank again: what they wrote now is the update itself, so the update
        is taken away, as the dialog's "Their answer now matches your update." says."""
        app_id = self._approved(world, **{KEY: "Paper & Pine"})
        _update(app_id, "")
        _submit(world, VENDOR)
        assert KEY not in _doc(world, app_id)["form_data"]

        _update(app_id, "")

        doc = _doc(world, app_id)
        assert KEY not in (doc.get("answer_updates") or {})
        assert KEY not in doc["form_data"]
        entry = world.history.documents[-1]
        assert entry["detail"]["matched"] == {KEY: ""}
        assert "kept" not in entry["detail"]

    def test_a_blank_one_for_a_vendor_who_gave_none_changes_nothing(self, world):
        app_id = self._approved(world)
        before = dict(_doc(world, app_id))
        entries = len(world.history.documents)

        _update(app_id, "  ")

        assert _doc(world, app_id) == before
        assert len(world.history.documents) == entries

    def test_it_asks_no_assignment_or_price_row(self, world, monkeypatch):
        app_id = self._approved(world)
        asked = []
        refusal = Actions.refusal

        def asking(row, *args):
            asked.append(row)
            return refusal(row, *args)

        monkeypatch.setattr(Actions, "refusal", asking)

        _update(app_id, "Paper & Pine")

        assert Actions.UPDATE_VENDOR_INFO in asked
        assert Actions.UPDATE_ASSIGNMENT_OR_PRICE_INFO not in asked


class TestASearchOnTheResults:
    def _terms(self, monkeypatch, doc):
        fake = FakeApplicationsCollection()
        fake.documents = [{"market_id": "market-1", "applicant_email": VENDOR, **doc}]
        monkeypatch.setattr(ApplicationsApi, "applications_collection", fake)
        monkeypatch.setattr(ApplicationsApi, "ensure_application_indexes", lambda: None)
        fields = [FormField(key="handle", label="Handle", type="text")]
        return ApplicationsApi.vendor_search_terms_for_market("market-1", fields, [VENDOR])

    def test_a_vendor_is_found_by_it_after_their_names(self, monkeypatch):
        terms = self._terms(monkeypatch, {"form_data": {
            EF.FULL_NAME_KEY: "Ana Rivera", EF.PREFERRED_NAME_KEY: "Annie",
            KEY: "Paper & Pine", "handle": "@paperandpine"}})

        assert terms == {VENDOR: ["Annie", "Ana Rivera", "Paper & Pine", "@paperandpine"]}

    def test_an_organizers_update_of_it_is_what_is_found(self, monkeypatch):
        terms = self._terms(monkeypatch, {
            "form_data": {EF.FULL_NAME_KEY: "Ana Rivera", KEY: "Paper & Pine"},
            "answer_updates": {KEY: {"value": "Pine & Paper"}}})

        assert terms == {VENDOR: ["Ana Rivera", "Pine & Paper"]}

    def test_one_blanked_by_an_organizer_finds_nobody(self, monkeypatch):
        terms = self._terms(monkeypatch, {
            "form_data": {EF.FULL_NAME_KEY: "Ana Rivera", KEY: "Paper & Pine"},
            "answer_updates": {KEY: {"value": ""}}})

        assert terms == {VENDOR: ["Ana Rivera"]}


#: The words an answer means "none" by, as the import reads a per-day grid's cell (Daniel's Q7).
NONE_ANSWERS = ["N/A", "none", "  NA ", "Not available", "unavailable", "-"]


class TestAnAnswerThatIsANoneWord:
    """An answer that is exactly a none word, in any capitals, is no business name wherever one is
    stored: such a vendor has no line under their name. One that only holds such a word is a name.
    """

    @pytest.mark.parametrize("given", NONE_ANSWERS)
    def test_it_stores_no_key_as_a_blank_does(self, given):
        error, stored = EF.validated_essential_answers({**NAMED, KEY: given}, EMPTY)

        assert error is None, error
        assert KEY not in stored

    @pytest.mark.parametrize("given", ["N/A Studios", "None Such Ceramics", "-ish Prints"])
    def test_one_that_only_holds_a_none_word_is_kept(self, given):
        error, stored = EF.validated_essential_answers({**NAMED, KEY: f" {given} "}, EMPTY)

        assert (error, stored[KEY]) == (None, given)

    @pytest.mark.parametrize("given", NONE_ANSWERS)
    def test_an_organizers_update_to_one_is_stored_as_a_blank_update_is(self, given):
        error, stored = EF.validated_essential_update(
            {**NAMED, KEY: "Paper & Pine"}, {KEY: given}, EMPTY, limit_required=False)

        assert (error, stored) == (None, {KEY: ""})

    @pytest.mark.parametrize("given", ["N/A", "none"])
    def test_an_applicants_save_stores_no_key(self, world, given):
        assert _save(world, **{KEY: given}).status_code == 200

        assert KEY not in _doc(world, _id_of(world, VENDOR))["form_data"]

    def test_an_applicants_save_keeps_one_that_only_holds_a_none_word(self, world):
        assert _save(world, **{KEY: "N/A Studios"}).status_code == 200

        assert _doc(world, _id_of(world, VENDOR))["form_data"][KEY] == "N/A Studios"

    @pytest.mark.parametrize("given", ["N/A", "none"])
    def test_one_stored_with_no_key_keeps_its_approval_on_a_save_of_one(self, world, given):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)
        assert KEY not in _doc(world, app_id)["form_data"]
        _approve(app_id)

        assert _save(world, **{KEY: given}).status_code == 200

        assert _doc(world, app_id)["status"] == ApplicationStatus.REVIEWER_APPROVED.value
        assert _edits(world, app_id) == []

    def test_an_import_stores_no_key_for_one_and_keeps_one_that_only_holds_it(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        headers = [*HEADERS, "Trading as"]
        mapping = {**MAPPING, KEY: len(HEADERS)}
        importing = TestAnImport()

        importing._import(GOOD_ROW + ",N/A", mapping, headers)
        importing._import(GOOD_ROW.replace("nadia@", "theo@") + ",none", mapping, headers)
        importing._import(GOOD_ROW.replace("nadia@", "ivy@") + ",N/A Studios", mapping, headers)

        assert KEY not in _doc(world, _id_of(world, "nadia@ember.test"))["form_data"]
        assert KEY not in _doc(world, _id_of(world, "theo@ember.test"))["form_data"]
        assert _doc(world, _id_of(world, "ivy@ember.test"))["form_data"][KEY] == "N/A Studios"

    def test_an_import_of_one_over_an_application_stored_with_no_key_changes_nobody(self, world):
        world.use(_import_market_doc(phase=MarketPhase.APPLICATIONS))
        headers = [*HEADERS, "Trading as"]
        mapping = {**MAPPING, KEY: len(HEADERS)}
        importing = TestAnImport()
        importing._import(GOOD_ROW + ",", mapping, headers)
        app_id = _id_of(world, "nadia@ember.test")
        _approve(app_id)
        before = dict(_doc(world, app_id))

        body = importing._import(GOOD_ROW + ",N/A", mapping, headers)

        assert (body["unchanged"], body["updated"], body["returnedToReview"]) == (1, 0, 0)
        assert _doc(world, app_id) == before

    @pytest.mark.parametrize("given", ["N/A", "none"])
    def test_update_info_with_one_over_a_vendor_who_gave_none_changes_nothing(self, world, given):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)
        _approve(app_id)
        before = dict(_doc(world, app_id))

        _update(app_id, given)

        assert _doc(world, app_id) == before

    def test_update_info_with_one_over_a_vendors_name_stands_as_a_blank_update(self, world):
        _submit(world, VENDOR, **{KEY: "Paper & Pine"})
        app_id = _id_of(world, VENDOR)

        _update(app_id, "N/A")

        doc = _doc(world, app_id)
        assert (doc["answer_updates"][KEY]["value"], doc["answer_updates"][KEY]["over"]) == (
            "", "Paper & Pine")
        assert EF.business_name(ApplicationsApi.effective_answers(doc)) == ""

    def test_update_info_keeps_one_that_only_holds_a_none_word(self, world):
        _submit(world, VENDOR)
        app_id = _id_of(world, VENDOR)

        _update(app_id, "N/A Studios")

        assert _doc(world, app_id)["answer_updates"][KEY]["value"] == "N/A Studios"

    def test_the_none_words_are_the_imports_own_set(self):
        assert EF.NONE_WORDS is CsvImport.NONE_WORDS
