"""The standard security headers every API answer carries.

The API answers JSON, a CSV export and floorplan images, never a page, so it needs no
Content-Security-Policy of its own; the front end's (``front-end/vercel.json``) covers the pages.
What an answer does need:

- ``X-Content-Type-Options: nosniff``: a browser reads the answer as the type it says, so a JSON
  answer that echoes an applicant's words is never sniffed into a script or a page.
- ``Referrer-Policy: no-referrer``: an API address can carry a market's id, and nothing the API
  answers should hand it on.
- ``Strict-Transport-Security: max-age=63072000; includeSubDomains``: a browser that has reached the
  API once reaches it only over HTTPS for two years, whatever the host in front of it adds. The value
  is the front end's. A browser ignores it on plain HTTP, on an IP address and on a certificate it
  does not trust, so the local stack, served at ``127.0.0.1`` with a self-signed certificate, is
  untouched by it.
"""

from flask import Flask, Response

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
}


def install_security_headers(app: Flask) -> None:
    """Add ``SECURITY_HEADERS`` to every answer, error answers and CORS preflights included.

    One ``after_request`` on the app, so a route added later carries them without doing anything.
    It only adds headers, so where it sits among the other ``after_request`` handlers (flask-cors's)
    changes nothing either of them does.
    """

    @app.after_request
    def add_security_headers(response: Response) -> Response:
        for name, value in SECURITY_HEADERS.items():
            response.headers[name] = value
        return response
