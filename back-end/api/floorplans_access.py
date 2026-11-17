"""
The one place a floorplan route decides who may use it.

Every floorplan action asks its row of the table (``api.market_actions``) on the floorplan's
market: a route that names a market asks on that market, and a route that takes an image id asks on
the market the image was uploaded for. Each function answers None when the caller may go on, or
the refusal to answer with (a JSON body and a status), in the order save-to-market answers: no
market named 400, unknown market or image 404, a stored market the model refuses 400 "Invalid
market data", then a person the row refuses 403 with its sentence, then an archived market 403 for
a route that changes something.

A route that records its change asks with ``market_asking`` or ``image_asking``, which answer the
asking of its row (``Actions.Asked``) when the caller may go on, so the change is recorded through
the check that let it in, under that row (T105-9); a route that records nothing asks with
``market_refusal`` or ``image_refusal``.

Call these only from a route carrying ``@login_required``.
"""

from typing import Any, Dict, Optional, Tuple

import api.markets as MarketsApi
import api.market_actions as Actions
from services.gridfs_service import get_image_market_id
from utils.identity import authenticated_email

Refusal = Tuple[Dict[str, Any], int]

#: A check's answer: the asking of its row when the caller may go on, else the refusal to answer.
Asking = Tuple[Optional[Actions.Asked], Optional[Refusal]]


def market_asking(
    market_id: Optional[str], action: Actions.Action, *, edits: bool
) -> Asking:
    """The asking of ``action`` on this market, and no refusal, when the caller may use the route;
    else no asking, and why not.

    ``edits`` marks a route that changes the market's floorplan, which an archived market refuses.
    """
    if not market_id:
        return None, ({"error": "market_id is required"}, 400)

    context = MarketsApi.load_market_context(market_id)
    if context is None:
        return None, ({"error": "Market not found"}, 404)
    if context.market is None:
        return None, ({"error": "Invalid market data"}, 400)

    asked = Actions.ask(action, authenticated_email(), context.market, context.organization)
    if asked.refused:
        return None, ({"error": asked.refused}, 403)

    if edits:
        archived = MarketsApi.archived_refusal(context.market)
        if archived:
            return None, ({"error": archived}, 403)
    return asked, None


def image_asking(
    gridfs_id: Optional[str], action: Actions.Action, *, edits: bool
) -> Asking:
    """``market_asking`` on the market the image was uploaded for.

    An unknown image and an image stored without a market both answer "Image not found": no route
    treats an unowned image as anyone's.
    """
    market_id = get_image_market_id(gridfs_id) if gridfs_id else None
    if market_id is None:
        return None, ({"error": "Image not found"}, 404)
    return market_asking(market_id, action, edits=edits)


def market_refusal(
    market_id: Optional[str], action: Actions.Action, *, edits: bool
) -> Optional[Refusal]:
    """Why the caller may not use a floorplan route on this market, or None when they may."""
    return market_asking(market_id, action, edits=edits)[1]


def image_refusal(
    gridfs_id: Optional[str], action: Actions.Action, *, edits: bool
) -> Optional[Refusal]:
    """Why the caller may not use a floorplan route on this image, or None when they may."""
    return image_asking(gridfs_id, action, edits=edits)[1]
