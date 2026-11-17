"""A card decided between the queue's read and its claim is passed over (T277 P4).

``review/next`` reads the market's applications, picks the next undecided one in arrival order, and
claims it. The claim held only who held the card, so a verdict another reviewer gave between that
read and the claim was not seen: the reviewer was handed a card decided a moment before, and
reviewed it as if it were open. The claim now holds the status the queue read, so a card decided
meanwhile is passed over and the next undecided one is handed.
"""
from test_choosing_reviewers_deals_the_open_applications import (  # noqa: F401  (the fixture)
    ADMIN, EDITOR, MARKET, _client, world,
)

import api.applications as ApplicationsApi


def _doc(world, app_id):
    return next(d for d in world.applications.documents if d["id"] == app_id)


def _a_verdict_lands_after_the_read(monkeypatch, world, app_id):
    """The Editor approves ``app_id`` through the review route as soon as the next card's queue has
    been read, before its claim is written."""
    read = ApplicationsApi.list_applications_for_market
    landed = []

    def read_then_a_verdict(market_id):
        docs = read(market_id)
        if not landed:
            doc = _doc(world, app_id)
            seen = {"status": doc["status"], "verdictAt": doc.get("verdict_at"),
                    "updatedAt": doc.get("updated_at")}
            response = _client(EDITOR).put(
                f"/markets/{MARKET}/applications/{app_id}/review",
                json={"status": "reviewer_approved", "seen": seen})
            assert response.status_code == 200, response.get_json()
            landed.append(app_id)
        return docs

    monkeypatch.setattr(ApplicationsApi, "list_applications_for_market", read_then_a_verdict)
    return landed


def test_the_decided_card_is_passed_over_and_the_next_one_is_handed(monkeypatch, world):
    landed = _a_verdict_lands_after_the_read(monkeypatch, world, "app-v1")

    response = _client(ADMIN).post(f"/markets/{MARKET}/review/next", json={})

    assert landed == ["app-v1"]
    assert response.status_code == 200, response.get_json()
    handed = response.get_json()["application"]
    assert handed["id"] == "app-v2"
    assert handed["status"] == "open"
    decided = _doc(world, "app-v1")
    assert decided["status"] == "reviewer_approved"
    assert "held_by" not in decided


def test_the_card_handed_is_held_for_the_reviewer(monkeypatch, world):
    _a_verdict_lands_after_the_read(monkeypatch, world, "app-v1")

    _client(ADMIN).post(f"/markets/{MARKET}/review/next", json={})

    assert _doc(world, "app-v2")["held_by"]["email"] == ADMIN


def test_a_card_asked_for_by_name_and_decided_meanwhile_is_passed_over(monkeypatch, world):
    _a_verdict_lands_after_the_read(monkeypatch, world, "app-v3")

    response = _client(ADMIN).post(f"/markets/{MARKET}/review/next", json={"want": "app-v3"})

    assert response.get_json()["application"]["id"] == "app-v1"
