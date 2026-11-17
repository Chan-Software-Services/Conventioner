"""A vendor's chosen answers as the public map publishes them, cleaned (T422, D28, ADR 0035).

The public map shows anyone three of a vendor's answers, each read from a short text question of the
market's own form the organizer chose: a public name, a website and an Instagram handle. They are
free text a vendor typed, so each is read here into the one shape it may take, or into None, and
the map publishes only what this answers: never the raw answer.

- A name is trimmed, its inner runs of whitespace made one space, its characters that draw nothing
  or turn the text round left out (a control, a zero-width space, a direction override; a joiner
  of emoji stays), and cut at ``NAME_LIMIT`` characters; it is None when empty, and None when an
  email address stands anywhere in it, since the rule "never an email address" holds whatever was
  typed: an address written with spaces round its at sign, with a look-alike at sign or with a
  literal host in brackets reads as one too.
- A website is an ``http`` or ``https`` address with a host and no user part, of at most
  ``WEBSITE_LIMIT`` characters, with no whitespace, control or character that draws nothing, and
  no email address in its path, query or fragment; an answer with no scheme that reads as a domain
  (letters, digits, dots and hyphens, a dot, a top-level label of two letters or more, then an
  optional path) is given ``https://``. Anything else, ``javascript:`` among it, is None.
- An Instagram handle is 1 to ``HANDLE_LIMIT`` letters, digits, dots and underscores, a letter or a
  digit among them, read from ``@name``, ``name``, or an ``instagram.com/name`` address with or
  without its scheme, ``www.`` and a trailing slash or query; a page of Instagram's own (``p``,
  ``explore``, ``reels`` and the like) is none. Anything else is None.

Every search here runs in time linear in the answer, since no limit holds a short text answer's
length and the map is read by anyone.

Pure: no reader, no database. The map's read (``public_map``) is its one caller.
"""
import re
import unicodedata
from typing import Any, Optional
from urllib.parse import unquote, urlsplit

NAME_LIMIT = 80
WEBSITE_LIMIT = 200
HANDLE_LIMIT = 30

#: How many spaces may stand on each side of an address's at sign: "jane @ example.org".
_AT_GAP = 3
#: A character that may end an address's local part, just before its at sign.
_LOCAL_END = re.compile(r"[^\s@<>()\[\]/?#&=:,;\"']")
#: What follows an address's at sign: a domain with a dot, or a literal host in brackets. Each
#: quantifier is bounded and no two overlap, so a match at one at sign costs a bounded time.
_DOMAIN_AFTER_AT = re.compile(
    rf"\s{{0,{_AT_GAP}}}(?:\[[^\]\s]{{1,255}}\]|[\w-]{{1,63}}(?:\.[\w-]{{1,63}}){{1,16}})")
#: Instagram's own pages, which its address may name where a profile's handle stands.
_INSTAGRAM_PAGES = frozenset(
    {"p", "reel", "reels", "explore", "stories", "accounts", "direct", "tv", "about", "legal"})
_WHITESPACE = re.compile(r"\s+")
#: A domain and an optional path, with no scheme: what is given ``https://``.
_BARE_DOMAIN = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(/\S*)?$")
#: A host as an address may name it: labels of letters, digits and hyphens, the last of letters.
_HOST = re.compile(r"^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")
_HANDLE = re.compile(rf"^(?=[._]*[A-Za-z0-9])[A-Za-z0-9._]{{1,{HANDLE_LIMIT}}}$")
#: An Instagram profile's address: the host, one path segment, an optional slash and query.
_INSTAGRAM_ADDRESS = re.compile(
    r"^(?:https?://)?(?:www\.)?instagram\.com/([^/?#\s]+)/?(?:\?\S*)?$", re.IGNORECASE)


def _has_email(text: str) -> bool:
    """Whether an email address stands anywhere in the text.

    Read outward from each at sign, never by one search over the whole text, so that a long answer
    costs time linear in it. The text is read in its compatibility form, where a look-alike at sign
    (``＠``, ``﹫``) is an at sign and a fullwidth letter its plain one.
    """
    text = unicodedata.normalize("NFKC", text)
    at = text.find("@")
    while at != -1:
        before = text[max(0, at - _AT_GAP - 1):at].rstrip()
        if before and _LOCAL_END.match(before[-1]) and _DOMAIN_AFTER_AT.match(text, at + 1):
            return True
        at = text.find("@", at + 1)
    return False


def _drawn(char: str) -> bool:
    """Whether a character of a name is kept: no control and no format character (a zero-width
    space, a direction override), but the joiner that makes one emoji of several."""
    return char == "\u200d" or unicodedata.category(char) not in ("Cc", "Cf")


def _text(raw: Any) -> Optional[str]:
    """The answer trimmed, or None for one that is no text or holds none."""
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    return text or None


def public_name(raw: Any) -> Optional[str]:
    """A vendor's public name as the map shows it, or None for none it may show."""
    text = _text(raw)
    if text is None:
        return None
    text = "".join(char for char in _WHITESPACE.sub(" ", text) if _drawn(char))
    text = _WHITESPACE.sub(" ", text).strip()
    if not text or _has_email(text):
        return None
    return text[:NAME_LIMIT].strip() or None


def public_website(raw: Any) -> Optional[str]:
    """A vendor's website as the map links it, or None for an answer that is no web address."""
    text = _text(raw)
    if text is None or _WHITESPACE.search(text):
        return None
    if any(unicodedata.category(char) in ("Cc", "Cf") for char in text):
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
    # An address in the path, the query or the fragment would be published in the link's address;
    # an at sign that starts a profile's path ("/@shop") is none.
    if any(_has_email(unquote(part)) for part in (parts.path, parts.query, parts.fragment)):
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
    if handle.lower() in _INSTAGRAM_PAGES:
        return None
    return handle if _HANDLE.match(handle) else None
