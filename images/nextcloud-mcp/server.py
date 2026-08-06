"""Minimal MCP server exposing a Nextcloud tenant's files over WebDAV.

Proof of concept for AppProfile.spec.sidecars — a small companion service
deployed alongside Nextcloud, authenticating as its own dedicated,
low-privilege Nextcloud account (never the tenant admin). See
gentian-apps/profiles/nextcloud/drive/nextcloud-drive-ce/profile.yaml for how this is wired in.

Exposes three tools, deliberately narrow (files only, no tasks/calendar/etc
— see the AppProfile decision record for why): listFiles, searchFiles,
readFile.
"""

import os
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote, urlparse

import httpx
from mcp.server.fastmcp import FastMCP

NEXTCLOUD_BASE_URL = os.environ.get("NEXTCLOUD_BASE_URL", "http://nextcloud")
NEXTCLOUD_MCP_USER = os.environ["NEXTCLOUD_MCP_USER"]
NEXTCLOUD_MCP_PASSWORD = os.environ["NEXTCLOUD_MCP_PASSWORD"]

# WebDAV root for this account's own space. A dedicated low-privilege
# account, not the tenant admin or the chatting user — see the profile's
# postInstallJob for how it's provisioned and what it can actually reach
# (its own files plus whatever's explicitly shared with it).
DAV_ROOT = f"{NEXTCLOUD_BASE_URL}/remote.php/dav/files/{NEXTCLOUD_MCP_USER}"

DAV_NS = "{DAV:}"
MAX_READ_BYTES = 1_000_000
MAX_SEARCH_RESULTS = 50

# host must be 0.0.0.0 -- FastMCP defaults to 127.0.0.1, unreachable from
# other pods/containers even though this runs in Nextcloud's own pod.
mcp = FastMCP(
    "nextcloud-files",
    host="0.0.0.0",
    port=int(os.environ.get("MCP_PORT", "8765")),
)


def _dav_client() -> httpx.Client:
    return httpx.Client(
        auth=(NEXTCLOUD_MCP_USER, NEXTCLOUD_MCP_PASSWORD),
        timeout=15.0,
    )


def _dav_url(path: str) -> str:
    # quote() each segment individually -- filenames can contain characters
    # (#, ?, %, spaces) that are meaningful in a URL (# in particular is a
    # fragment delimiter: httpx silently drops everything after it if the
    # path is interpolated raw, truncating the request without erroring).
    segments = [quote(seg, safe="") for seg in path.strip("/").split("/") if seg]
    return DAV_ROOT + "/" + "/".join(segments)


def _propfind(path: str, depth: str) -> ET.Element:
    body = """<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>"""
    url = _dav_url(path)
    with _dav_client() as client:
        resp = client.request(
            "PROPFIND",
            url,
            content=body,
            headers={"Depth": depth, "Content-Type": "application/xml"},
        )
    resp.raise_for_status()
    return ET.fromstring(resp.content)


def _entry_from_response(resp_el: ET.Element, dav_prefix: str) -> dict | None:
    href = resp_el.findtext(f"{DAV_NS}href")
    if href is None:
        return None
    rel_path = href[len(dav_prefix) :] if href.startswith(dav_prefix) else href
    rel_path = unquote(rel_path.rstrip("/"))
    if not rel_path:
        return None  # the collection itself, not a child entry
    propstat = resp_el.find(f"{DAV_NS}propstat")
    prop = propstat.find(f"{DAV_NS}prop") if propstat is not None else None
    resourcetype = prop.find(f"{DAV_NS}resourcetype") if prop is not None else None
    is_dir = resourcetype is not None and resourcetype.find(f"{DAV_NS}collection") is not None
    size_text = prop.findtext(f"{DAV_NS}getcontentlength") if prop is not None else None
    return {
        "path": rel_path,
        "name": rel_path.rsplit("/", 1)[-1],
        "is_dir": is_dir,
        "size": int(size_text) if size_text else None,
        "modified": prop.findtext(f"{DAV_NS}getlastmodified") if prop is not None else None,
    }


@mcp.tool()
def listFiles(path: str = "") -> list[dict]:
    """List files and folders at a path in this account's Nextcloud space.

    path: folder to list, relative to the account's own root (empty = root).
    """
    root = _propfind(path, depth="1")
    dav_prefix = urlparse(DAV_ROOT).path.rstrip("/") + "/"
    entries = []
    for resp_el in root.findall(f"{DAV_NS}response"):
        entry = _entry_from_response(resp_el, dav_prefix)
        if entry is not None:
            entries.append(entry)
    return entries


@mcp.tool()
def searchFiles(query: str) -> list[dict]:
    """Search filenames (substring match) in this account's Nextcloud space.

    query: substring to match against file/folder names, case-insensitive.
    """
    root = _propfind("", depth="infinity")
    dav_prefix = urlparse(DAV_ROOT).path.rstrip("/") + "/"
    needle = query.lower()
    matches = []
    for resp_el in root.findall(f"{DAV_NS}response"):
        entry = _entry_from_response(resp_el, dav_prefix)
        if entry is not None and needle in entry["name"].lower():
            matches.append(entry)
            if len(matches) >= MAX_SEARCH_RESULTS:
                break
    return matches


@mcp.tool()
def readFile(path: str) -> str:
    """Read a text file's contents from this account's Nextcloud space.

    path: file to read, relative to the account's own root.
    Refuses files over ~1MB or that aren't valid UTF-8 text.
    """
    url = _dav_url(path)
    with _dav_client() as client:
        resp = client.get(url)
    resp.raise_for_status()
    if len(resp.content) > MAX_READ_BYTES:
        raise ValueError(f"file too large ({len(resp.content)} bytes) — refusing to read")
    return resp.content.decode("utf-8")


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
