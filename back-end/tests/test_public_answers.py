"""What the public map publishes of a vendor's chosen answers, cleaned (T422, D28).

The answers are free text a vendor typed, and the map shows them to anyone, so each is read here
into the one shape it may take, or into nothing: a public name that is not an email address, a
website that is an ``http`` or ``https`` address, an Instagram handle. Anything else is left out,
never shown raw.
"""
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
    ("Ember & Ash", "Ember & Ash"),
    # Markup is text: the page renders it as text, never as HTML.
    ("<b>Ember</b>", "<b>Ember</b>"),
    ("x" * 81, "x" * 80),
    ("x" * 80, "x" * 80),
    # Cut at 80, then trimmed, so no name ends in a space.
    ("x" * 79 + " yz", "x" * 79),
])
def test_a_public_name(raw, cleaned):
    assert public_name(raw) == cleaned


@pytest.mark.parametrize("raw,cleaned", [
    ("https://ember-ceramics.test", "https://ember-ceramics.test"),
    ("http://ember-ceramics.test/shop", "http://ember-ceramics.test/shop"),
    ("  https://ember-ceramics.test/shop?item=3  ", "https://ember-ceramics.test/shop?item=3"),
    ("HTTPS://Ember-Ceramics.test", "HTTPS://Ember-Ceramics.test"),
    # A bare domain is given https://.
    ("ember-ceramics.test", "https://ember-ceramics.test"),
    ("www.ember-ceramics.test/shop", "https://www.ember-ceramics.test/shop"),
    ("shop.ember.co.uk/pots/", "https://shop.ember.co.uk/pots/"),
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
])
def test_a_website(raw, cleaned):
    assert public_website(raw) == cleaned


@pytest.mark.parametrize("raw,cleaned", [
    ("@ember.ceramics", "ember.ceramics"),
    ("ember_ceramics", "ember_ceramics"),
    ("  @Ember.Ceramics_2  ", "Ember.Ceramics_2"),
    ("instagram.com/ember.ceramics", "ember.ceramics"),
    ("www.instagram.com/ember.ceramics/", "ember.ceramics"),
    ("https://www.instagram.com/ember.ceramics/", "ember.ceramics"),
    ("http://instagram.com/ember.ceramics?igsh=abc123", "ember.ceramics"),
    ("https://instagram.com/ember.ceramics/?hl=en", "ember.ceramics"),
    ("INSTAGRAM.COM/ember", "ember"),
    ("a", "a"),
    ("a" * 30, "a" * 30),
    ("a" * 31, None),
    # A handle with a space, or anything but letters, digits, dots and underscores, is none.
    ("ember ceramics", None),
    ("@ember ceramics", None),
    ("ember-ceramics", None),
    ("@@ember", None),
    ("@", None),
    ("", None),
    (None, None),
    (["ember"], None),
    ("<script>", None),
    ("javascript:alert(1)", None),
    ("orders@ember-ceramics.test", None),
    # Another site's address, or a page of Instagram's that is no profile.
    ("https://ember-ceramics.test/ember", None),
    ("https://www.instagram.com/", None),
    ("https://www.instagram.com/p/C0deX/", None),
    ("https://evil.test/instagram.com/ember", None),
    ("https://instagram.com.evil.test/ember", None),
])
def test_an_instagram_handle(raw, cleaned):
    assert instagram_handle(raw) == cleaned
