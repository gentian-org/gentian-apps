#!/usr/bin/env python3
"""Establish an OpenProject browser session from a portal-issued bridge ticket."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

PORTAL_API = os.environ.get(
    "GENTIAN_PORTAL_BRIDGE_API",
    "http://gentian-portal-gentian-portal-api.platform-kernel.svc.cluster.local:8000/api/v1",
).rstrip("/")
OPENPROJECT_URL = os.environ.get("OPENPROJECT_URL", "http://openproject:8080").rstrip("/")
OPENPROJECT_HOST = os.environ.get("OPENPROJECT_HOST", "").strip()
PORTAL_FRAME_ANCESTOR = os.environ.get(
    "PORTAL_FRAME_ANCESTOR",
    "https://portal.desk.gentian.org",
).strip()
LISTEN_PORT = int(os.environ.get("PORT", "8080"))

_SSO_HTML = """<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signing in to Projects…</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body {
        margin: 0;
        font-family: system-ui, sans-serif;
        display: grid;
        place-items: center;
        min-height: 100vh;
        background: #f5f7f6;
        color: #1a2e28;
      }
    </style>
  </head>
  <body>
    <p>Signing in to Projects…</p>
    <script>
      (async () => {
        const ticket = new URLSearchParams(window.location.search).get("t");
        if (!ticket) {
          window.location.replace("/");
          return;
        }
        window.location.replace(
          `/gentian-portal-bridge?t=${encodeURIComponent(ticket)}`,
        );
      })();
    </script>
  </body>
</html>
"""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _openproject_headers() -> dict[str, str]:
    host_header = OPENPROJECT_HOST or urllib.parse.urlparse(OPENPROJECT_URL).netloc
    headers: dict[str, str] = {"X-Forwarded-Proto": "https"}
    if host_header:
        headers["Host"] = host_header
    return headers


def _openproject_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect())


def _request(
    method: str,
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    opener: urllib.request.OpenerDirector | None = None,
) -> tuple[int, Any, bytes]:
    req = urllib.request.Request(url, data=data, method=method)
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    client = opener or urllib.request.build_opener()
    try:
        with client.open(req, timeout=20) as response:
            body = response.read()
            return response.status, response.headers, body
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, exc.headers, body


def _redeem_ticket(ticket: str) -> dict[str, str]:
    redeem_url = (
        f"{PORTAL_API}/session/openproject-bridge/redeem/"
        f"{urllib.parse.quote(ticket, safe='')}"
    )
    status, _, body = _request("GET", redeem_url, headers={"Accept": "application/json"})
    if status >= 400:
        raise ValueError("redeem failed")
    payload = json.loads(body.decode("utf-8"))
    username = payload.get("username")
    password = payload.get("password")
    if not isinstance(username, str) or not username:
        raise ValueError("invalid ticket")
    if not isinstance(password, str) or not password:
        raise ValueError("invalid ticket")
    return {"username": username, "password": password}


def _extract_authenticity_token(html: str) -> str:
    match = re.search(
        r'class="-wide-labels user-login--form form"[^>]*>.*?name="authenticity_token" value="([^"]+)"',
        html,
        re.S,
    )
    if match:
        return match.group(1)
    fallback = re.search(r'name="authenticity_token" value="([^"]+)"', html)
    return fallback.group(1) if fallback else ""


def _cookie_header(set_cookie_values: list[str]) -> str:
    cookies: list[str] = []
    for header in set_cookie_values:
        cookie = header.split(";", 1)[0].strip()
        if cookie:
            cookies.append(cookie)
    return "; ".join(cookies)


def _collect_set_cookies(headers: Any) -> list[str]:
    if hasattr(headers, "get_all"):
        values = headers.get_all("Set-Cookie") or []
        return [value for value in values if value]
    value = headers.get("Set-Cookie")
    return [value] if value else []


def _normalize_redirect(location: str | None) -> str:
    if not location:
        return "/"
    parsed = urllib.parse.urlparse(location)
    if parsed.scheme and parsed.netloc:
        host = OPENPROJECT_HOST or urllib.parse.urlparse(OPENPROJECT_URL).netloc
        if parsed.netloc == host:
            path = parsed.path or "/"
            if parsed.query:
                path = f"{path}?{parsed.query}"
            return path
    if location.startswith("/"):
        return location
    return "/"


def _establish_openproject_session(username: str, password: str) -> tuple[list[str], str]:
    opener = _openproject_opener()
    base_headers = _openproject_headers()

    status, headers, body = _request(
        "GET",
        f"{OPENPROJECT_URL}/login",
        headers=base_headers,
        opener=opener,
    )
    if status >= 400:
        raise ValueError("login page failed")

    token = _extract_authenticity_token(body.decode("utf-8", errors="replace"))
    if not token:
        raise ValueError("missing authenticity token")

    set_cookies = _collect_set_cookies(headers)

    form = urllib.parse.urlencode(
        {
            "authenticity_token": token,
            "username": username,
            "password": password,
            "login": "Login",
        }
    ).encode("utf-8")

    login_headers = {
        **base_headers,
        "Content-Type": "application/x-www-form-urlencoded",
    }
    if set_cookies:
        login_headers["Cookie"] = _cookie_header(set_cookies)

    status, login_headers_out, _ = _request(
        "POST",
        f"{OPENPROJECT_URL}/login",
        data=form,
        headers=login_headers,
        opener=opener,
    )
    if status not in {HTTPStatus.FOUND, HTTPStatus.SEE_OTHER, HTTPStatus.MOVED_PERMANENTLY}:
        raise ValueError("login failed")

    session_cookies = _collect_set_cookies(login_headers_out)
    location = login_headers_out.get("Location") or ""
    if "two_factor" in location:
        raise ValueError("login requires two-factor authentication")
    if not session_cookies:
        raise ValueError("login failed without session cookie")

    return session_cookies, _normalize_redirect(location)


def _embedding_csp() -> str:
    return f"frame-ancestors 'self' {PORTAL_FRAME_ANCESTOR}"


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "OpenProjectPortalBridge/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._csp_sent = False
        super().__init__(*args, **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_header(self, keyword: str, value: str) -> None:
        if keyword.lower() == "content-security-policy":
            self._csp_sent = True
        super().send_header(keyword, value)

    def do_HEAD(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/openproject-portal-sso.html":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        if parsed.path == "/gentian-portal-bridge":
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.end_headers()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/openproject-portal-sso.html":
            self._send_html(_SSO_HTML)
            return

        if parsed.path != "/gentian-portal-bridge":
            self.send_error(HTTPStatus.NOT_FOUND)
            return

        ticket = urllib.parse.parse_qs(parsed.query).get("t", [""])[0]
        if not ticket:
            self.send_error(HTTPStatus.BAD_REQUEST, "Missing bridge ticket")
            return

        try:
            session = _redeem_ticket(ticket)
            cookies, location = _establish_openproject_session(
                session["username"],
                session["password"],
            )
        except ValueError as exc:
            sys.stderr.write("bridge auth failed: %s\n" % exc)
            self.send_error(HTTPStatus.UNAUTHORIZED, "Invalid or expired bridge ticket")
            return
        except urllib.error.URLError:
            self.send_error(HTTPStatus.BAD_GATEWAY, "Could not reach upstream service")
            return

        self.send_response(HTTPStatus.FOUND)
        for cookie in cookies:
            self.send_header("Set-Cookie", cookie)
        self.send_header("Location", location)
        self.end_headers()

    def end_headers(self) -> None:
        if not self._csp_sent:
            self.send_header("Content-Security-Policy", _embedding_csp())
        super().end_headers()

    def _send_html(self, html: str) -> None:
        encoded = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), BridgeHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
