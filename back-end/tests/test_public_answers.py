"""What the public map publishes of a vendor's chosen answers, cleaned (T422, D28).

The answers are free text a vendor typed, and the map shows them to anyone, so each is read here
into the one shape it may take, or into nothing: a public name that is not an email address, a
website that is an ``http`` or ``https`` address, an Instagram handle. Anything else is left out,
never shown raw.
"""
import time

import pytest

from public_answers import instagram_handle, public_name, public_website


@pytest.mark.parametrize("raw,cleaned", [
    ("Ember Ceramics", "Ember Ceramics"),
    ("  Ember   Ceramics \n", "Ember Ceramics"),
    ("Ember\tand Ash", "Ember and Ash"),
    ("", None),
    ("   ", None),
    (None, None),
    (42, None),
    (["Ember"], None),
    ({"name": "Ember"}, None),
    # An email address anywhere in it withholds the whole name.
    ("orders@ember-ceramics.test", None),
    ("Ember Ceramics (orders@ember-ceramics.test)", None),
    ("Ember Ceramics <ORDERS@EMBER.TEST>", None),
    # An at sign that is no address keeps the name.
    ("Ember @ the Market", "Ember @ the Market"),
    # An address written with spaces round its at sign, a look-alike at sign or a literal host reads
    # as one all the same.
    ("jane @ example.org", None),
    ("jane@ example.org", None),
    ("jane @example.org", None),
    ("jane\uff20example.org", None),
    ("jane\ufe6bexample.org", None),
    ("jane@[192.0.2.1]", None),
    ("Ember Ceramics, jane\u200b@example.org", None),
    # A long answer with no address is read in linear time: see test_a_long_name_is_read_at_once.
    ("Ember @@ the Market", "Ember @@ the Market"),
    ("Ember & Ash", "Ember & Ash"),
    # Markup is text: the page renders it as text, never as HTML.
    ("<b>Ember</b>", "<b>Ember</b>"),
    ("x" * 81, "x" * 80),
    ("x" * 80, "x" * 80),
    # Cut at 80, then trimmed, so no name ends in a space.
    ("x" * 79 + " yz", "x" * 79),
    # A character that draws nothing or turns the text round is left out; a joiner of emoji stays.
    ("Ember\u202e Ceramics", "Ember Ceramics"),
    ("Em\u200bber", "Ember"),
    ("\u2066Ember\u2069", "Ember"),
    ("Em\x01ber", "Ember"),
    ("Ember \U0001F469\u200d\U0001F3A8", "Ember \U0001F469\u200d\U0001F3A8"),
    ("\u202e", None),
])
def test_a_public_name(raw, cleaned):
    assert public_name(raw) == cleaned


@pytest.mark.parametrize("raw", [
    "a" * 200_000,
    "a@" * 100_000,
    "a" * 100_000 + "@" + "b" * 100_000,
    "a@b" + ".b" * 100_000,
    " @" * 100_000,
], ids=["no-at-sign", "many-at-signs", "one-at-sign-in-the-middle", "a-long-domain", "spaced-at-signs"])
def test_a_long_name_is_read_at_once(raw):
    """No length limit holds a short text answer, and the map is read by anyone, so a name of
    any length is read in time linear in it, never by a search that backtracks over it."""
    started = time.perf_counter()
    public_name(raw)
    assert time.perf_counter() - started < 0.5


@pytest.mark.parametrize("raw,cleaned", [
    ("https://ember-ceramics.test", "https://ember-ceramics.test"),
    ("http://ember-ceramics.test/shop", "http://ember-ceramics.test/shop"),
    ("  https://ember-ceramics.test/shop?item=3  ", "https://ember-ceramics.test/shop?item=3"),
    ("HTTPS://Ember-Ceramics.test", "HTTPS://Ember-Ceramics.test"),
    # A bare domain is given https://.
    ("ember-ceramics.test", "https://ember-ceramics.test"),
    ("www.ember-ceramics.test/shop", "https://www.ember-ceramics.test/shop"),
    ("shop.example.com/pots/", "https://shop.example.com/pots/"),
    # Not an address of the web.
    ("javascript:alert(1)", None),
    ("JavaScript:alert(1)", None),
    ("data:text/html,<script>alert(1)</script>", None),
    ("ftp://ember-ceramics.test", None),
    ("mailto:orders@ember-ceramics.test", None),
    ("//ember-ceramics.test", None),
    ("https://", None),
    ("https:///path", None),
    # An email address, in the user part or as the whole answer, is no website.
    ("https://orders@ember-ceramics.test", None),
    ("https://orders:secret@ember-ceramics.test", None),
    ("orders@ember-ceramics.test", None),
    # Text that is no domain.
    ("Ember Ceramics", None),
    ("ember", None),
    ("ember.c", None),
    ("ember.123", None),
    ("https://ember ceramics.test", None),
    ("https://ember-ceramics.test/a b", None),
    ("ember-ceramics.test/a b", None),
    ("", None),
    (None, None),
    (17, None),
    ("https://ember-ceramics.test/" + "a" * 172, "https://ember-ceramics.test/" + "a" * 172),
    ("https://ember-ceramics.test/" + "a" * 173, None),
    ("https://[::1", None),
    # An email address in the path, the query or the fragment is published by no link; an at sign
    # that starts a profile's path is no address.
    ("https://example.com/?contact=jane@example.org", None),
    ("example.com/jane@example.org", None),
    ("https://example.com/#jane@example.org", None),
    ("https://example.com/?contact=jane%40example.org", None),
    ("https://example.com/@example.shop", "https://example.com/@example.shop"),
    ("example.com/@exampleshop", "https://example.com/@exampleshop"),
    # A character that draws nothing, or a control, is no part of a web address.
    ("\x01https://example.com", None),
    ("https://example.com/\x7f", None),
    ("https://exam\u200bple.com", None),
    ("https://example.com/\u202epath", None),
])
def test_a_website(raw, cleaned):
    assert public_website(raw) == cleaned


@pytest.mark.parametrize("raw,cleaned", [
    ("@example.ceramics", "example.ceramics"),
    ("example_ceramics", "example_ceramics"),
    ("  @Example.Ceramics_2  ", "Example.Ceramics_2"),
    ("instagram.com/example.ceramics", "example.ceramics"),
    ("www.instagram.com/example.ceramics/", "example.ceramics"),
    ("https://www.instagram.com/example.ceramics/", "example.ceramics"),
    ("http://instagram.com/example.ceramics?igsh=abc123", "example.ceramics"),
    ("https://instagram.com/example.ceramics/?hl=en", "example.ceramics"),
    ("INSTAGRAM.COM/example", "example"),
    ("a", "a"),
    ("a" * 30, "a" * 30),
    ("a" * 31, None),
    # A handle with a space, or anything but letters, digits, dots and underscores, is none.
    ("example ceramics", None),
    ("@example ceramics", None),
    ("example-ceramics", None),
    ("@@example", None),
    ("@", None),
    ("", None),
    (None, None),
    (["example"], None),
    ("<script>", None),
    ("javascript:alert(1)", None),
    ("orders@ember-ceramics.test", None),
    # Another site's address, or a page of Instagram's that is no profile.
    ("https://ember-ceramics.test/example", None),
    ("https://www.instagram.com/", None),
    ("https://www.instagram.com/p/C0deX/", None),
    ("https://evil.test/instagram.com/example", None),
    ("https://instagram.com.evil.test/example", None),
    # A handle holds a letter or a digit, and Instagram's own pages are no profile.
    (".", None),
    ("..", None),
    ("_", None),
    ("@._", None),
    ("instagram.com/p/", None),
    ("https://www.instagram.com/explore/", None),
    ("instagram.com/reels/", None),
    ("instagram.com/reel", None),
    ("instagram.com/stories/", None),
    ("instagram.com/accounts", None),
    ("instagram.com/direct/", None),
    ("explore", None),
])
def test_an_instagram_handle(raw, cleaned):
    assert instagram_handle(raw) == cleaned
