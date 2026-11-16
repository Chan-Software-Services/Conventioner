"""A vendor's chosen answers as the public map publishes them, cleaned (T422, D28, ADR 0032).

The public map shows anyone three of a vendor's answers, each read from a short text question of the
market's own form the organizer chose: a public name, a website and an Instagram handle. They are
free text a vendor typed, so each is read here into the one shape it may take, or into None, and
the map publishes only what this answers: never the raw answer.

- A name is trimmed, its inner runs of whitespace made one space, and cut at
  ``NAME_LIMIT`` characters; it is None when empty, and None when an email address stands anywhere
  in it, since the rule "never an email address" holds whatever was typed.
- A website is an ``http`` or ``https`` address with a host and no user part, of at most
  ``WEBSITE_LIMIT`` characters and no whitespace; an answer with no scheme that reads as a domain
  (letters, digits, dots and hyphens, a dot, a top-level label of two letters or more, then an
  optional path) is given ``https://``. Anything else, ``javascript:`` among it, is None.
- An Instagram handle is 1 to ``HANDLE_LIMIT`` letters, digits, dots and underscores, read from
  ``@name``, ``name``, or an ``instagram.com/name`` address with or without its scheme, ``www.``
  and a trailing slash or query. Anything else is None.

Pure: no reader, no database. The map's read (``public_map``) is its one caller.
"""
import re
from typing import Any, Optional
from urllib.parse import urlsplit

NAME_LIMIT = 80
WEBSITE_LIMIT = 200
HANDLE_LIMIT = 30

#: An email address anywhere in a text: something, an at sign, a domain with a dot.
_EMAIL_IN = re.compile(r"[^\s@<>()\[\]]+@[^\s@<>()\[\]]+\.[^\s@<>()\[\]]+")
_WHITESPACE = re.compile(r"\s+")
#: A domain and an optional path, with no scheme: what is given ``https://``.
_BARE_DOMAIN = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(/\S*)?$")
#: A host as an address may name it: labels of letters, digits and hyphens, the last of letters.
_HOST = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
_HANDLE = re.compile(rf"^[A-Za-z0-9._]{{1,{HANDLE_LIMIT}}}$")
#: An Instagram profile's address: the host, one path segment, an optional slash and query.
_INSTAGRAM_ADDRESS = re.compile(
    r"^(?:https?://)?(?:www\.)?instagram\.com/([^/?#\s]+)/?(?:\?\S*)?$", re.IGNORECASE)


def _text(raw: Any) -> Optional[str]:
    """The answer trimmed, or None for one that is no text or holds none."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    return text or None


def public_name(raw: Any) -> Optional[str]:
    """A vendor's public name as the map shows it, or None for none it may show."""
    text = _text(raw)
    if text is None or _EMAIL_IN.search(text):
        return None
    return _WHITESPACE.sub(" ", text)[:NAME_LIMIT].strip() or None


def public_website(raw: Any) -> Optional[str]:
    """A vendor's website as the map links it, or None for an answer that is no web address."""
    text = _text(raw)
    if text is None or _WHITESPACE.search(text):
        return None
    if "://" not in text:
        if not _BARE_DOMAIN.match(text):
            return None
        text = f"https://{text}"
    if len(text) > WEBSITE_LIMIT:
        return None
    try:
        parts = urlsplit(text)
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not host or not _HOST.match(host):
        return None
    # A user part is an address hidden in a link, and a password in one is worse.
    if "@" in parts.netloc:
        return None
    return text


def instagram_handle(raw: Any) -> Optional[str]:
    """A vendor's Instagram handle, without its at sign, or None for an answer that is none."""
    text = _text(raw)
    if text is None:
        return None
    address = _INSTAGRAM_ADDRESS.match(text)
    if address:
        handle = address.group(1)
    elif text.startswith("@"):
        handle = text[1:]
    else:
        handle = text
    return handle if _HANDLE.match(handle) else None
