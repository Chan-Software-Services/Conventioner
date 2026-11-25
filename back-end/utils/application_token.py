"""The JWT an applicant holds after signing in with an emailed code.

Short-lived (30 min). It says who signed in, and to which market: the address that proved itself
by reading the code, and the market it signed in at. It is verified on every applicant endpoint
request. No Flask session is created.

It names no application. It did, and was only issued to an address that already had one, so a
vendor who had never applied could prove their address and still be turned away (bug 6, E26/F07/
S01). An applicant's application is found by market and address - its identity - and is created by
their first save, so the token stands for the person whether or not they have applied yet.

This token is the *only* thing standing between a caller and any applicant's application, so the
key it is signed with is derived from ``utils.secret_key``'s secret -- which has no fallback, and
no default -- for vendor tokens alone (``vendor_token_key``), so an organizer's session cookie,
signed with a key of its own, never stands for one. It is read per call rather than captured at
import so that a process which never had a secret cannot have signed anything before the boot check
got the chance to refuse.

Token payload::

    {
        "market_id": str,
        "email": str,
        "iat": int (unix timestamp),
        "exp": int (unix timestamp)
    }
"""
import time
from typing import Optional, Dict, Any

import jwt

from utils.secret_key import vendor_token_key

APPLICATION_TOKEN_EXPIRY_SECONDS = 30 * 60  # 30 minutes


def generate_application_token(market_id: str, email: str) -> str:
    """Sign a token for an applicant who has just proved their address at this market."""
    now = int(time.time())
    payload: Dict[str, Any] = {
        "market_id": market_id,
        "email": email,
        "iat": now,
        "exp": now + APPLICATION_TOKEN_EXPIRY_SECONDS,
    }
    return jwt.encode(payload, vendor_token_key(), algorithm="HS256")


def verify_application_token(token: str) -> Optional[Dict[str, Any]]:
    """The payload of a valid applicant token, or ``None`` when it is expired, malformed, forged,
    or does not say both who signed in and where."""
    try:
        payload = jwt.decode(token, vendor_token_key(), algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    if not payload.get("market_id") or not payload.get("email"):
        return None
    return payload
