"""MCP server exposing a Paperless-ngx tenant's documents to AI agents.

A companion of paperless-ngx-ce (spec.extensions), deployed beside Paperless
in the tenant's namespace and authenticating as its own ordinary Paperless
account -- never the technical superuser, never the person asking. The
profile's post-install hook makes that account, gives it the permissions
these tools need and nothing more, and adds a Paperless workflow that shares
each newly consumed document with it: Paperless shows a document only to its
owner and to whom it was shared with, so without that workflow the agent
would see nothing that a person uploaded.

Reading tools: searchDocuments, getDocument, getDocumentText, listTags,
listCorrespondents, listDocumentTypes, listCustomFields, getTask.
Writing tools, unless PAPERLESS_MCP_READ_ONLY is set: uploadDocument,
updateDocument, createTag. What a writing tool can do is bounded twice: by
this switch and by the account's permissions in Paperless.

The REST API is asked at version 10 (Paperless-ngx 3.x).
"""

from __future__ import annotations

import base64
import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

PAPERLESS_URL = os.environ.get("PAPERLESS_URL", "http://paperless-ngx-ce:8000").rstrip("/")
PAPERLESS_MCP_USER = os.environ["PAPERLESS_MCP_USER"]
PAPERLESS_MCP_PASSWORD = os.environ["PAPERLESS_MCP_PASSWORD"]
READ_ONLY = os.environ.get("PAPERLESS_MCP_READ_ONLY", "false").strip().lower() in ("1", "true", "yes")

API_VERSION = "10"
MAX_PAGE_SIZE = 100
# How much of a document's text one answer carries. A scanned letter is a few
# thousand characters; a long contract is read in slices (getDocumentText).
MAX_TEXT_CHARS = 20_000
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

# host must be 0.0.0.0 -- FastMCP defaults to 127.0.0.1, unreachable from
# other pods.
mcp = FastMCP(
    "paperless-ngx-documents",
    host="0.0.0.0",
    port=int(os.environ.get("MCP_PORT", "8765")),
)


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=PAPERLESS_URL,
        auth=(PAPERLESS_MCP_USER, PAPERLESS_MCP_PASSWORD),
        headers={"Accept": f"application/json; version={API_VERSION}"},
        timeout=30.0,
    )


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    with _client() as client:
        resp = client.get(path, params=params)
    resp.raise_for_status()
    return resp.json()


def _all(path: str) -> list[dict]:
    """Every object of a small collection (tags, correspondents, ...)."""
    out: list[dict] = []
    page = 1
    while True:
        data = _get(path, {"page": page, "page_size": MAX_PAGE_SIZE})
        out.extend(data.get("results", []))
        if not data.get("next"):
            return out
        page += 1


def _by_id(path: str) -> dict[int, dict]:
    return {int(o["id"]): o for o in _all(path)}


def _find(path: str, name: str) -> dict | None:
    """One object by name, case-insensitively, or None."""
    data = _get(path, {"name__iexact": name, "page_size": 1})
    results = data.get("results", [])
    return results[0] if results else None


def _require_writes() -> None:
    if READ_ONLY:
        raise PermissionError("this MCP server is read-only (PAPERLESS_MCP_READ_ONLY)")


def _summary(doc: dict, tags: dict[int, dict], correspondents: dict[int, dict], types: dict[int, dict]) -> dict:
    correspondent = correspondents.get(doc.get("correspondent") or -1)
    document_type = types.get(doc.get("document_type") or -1)
    return {
        "id": doc["id"],
        "title": doc.get("title"),
        "created": doc.get("created"),
        "added": doc.get("added"),
        "correspondent": correspondent["name"] if correspondent else None,
        "document_type": document_type["name"] if document_type else None,
        "tags": [tags[t]["name"] for t in doc.get("tags", []) if t in tags],
        "archive_serial_number": doc.get("archive_serial_number"),
        "original_file_name": doc.get("original_file_name"),
        "page_count": doc.get("page_count"),
        "custom_fields": doc.get("custom_fields", []),
    }


@mcp.tool()
def searchDocuments(
    query: str = "",
    tag: str = "",
    correspondent: str = "",
    document_type: str = "",
    page: int = 1,
    page_size: int = 25,
) -> dict:
    """Search this tenant's documents. Returns a page of summaries, no text.

    query: full-text search over title and OCR content (empty: every document).
    tag, correspondent, document_type: names to filter by, case-insensitive.
    Documents are the ones this account may see: those shared with it.
    """
    params: dict[str, Any] = {
        "page": max(1, page),
        "page_size": max(1, min(page_size, MAX_PAGE_SIZE)),
        "ordering": "-created",
    }
    if query.strip():
        params["query"] = query.strip()
    if tag.strip():
        found = _find("/api/tags/", tag.strip())
        if found is None:
            return {"count": 0, "page": page, "results": [], "note": f"no tag named {tag!r}"}
        params["tags__id__all"] = found["id"]
    if correspondent.strip():
        found = _find("/api/correspondents/", correspondent.strip())
        if found is None:
            return {"count": 0, "page": page, "results": [], "note": f"no correspondent named {correspondent!r}"}
        params["correspondent__id"] = found["id"]
    if document_type.strip():
        found = _find("/api/document_types/", document_type.strip())
        if found is None:
            return {"count": 0, "page": page, "results": [], "note": f"no document type named {document_type!r}"}
        params["document_type__id"] = found["id"]
    data = _get("/api/documents/", params)
    tags = _by_id("/api/tags/")
    correspondents = _by_id("/api/correspondents/")
    types = _by_id("/api/document_types/")
    return {
        "count": data.get("count", 0),
        "page": page,
        "has_more": bool(data.get("next")),
        "results": [_summary(d, tags, correspondents, types) for d in data.get("results", [])],
    }


@mcp.tool()
def getDocument(document_id: int) -> dict:
    """A document's metadata and its OCR text (the first 20,000 characters).

    document_id: the id from searchDocuments.
    The text is what Paperless extracted: OCR for a scan, the embedded text
    for a born-digital PDF. `text_truncated` says whether getDocumentText is
    needed for the rest. Notes and custom field values are included.
    """
    doc = _get(f"/api/documents/{document_id}/")
    tags = _by_id("/api/tags/")
    correspondents = _by_id("/api/correspondents/")
    types = _by_id("/api/document_types/")
    fields = _by_id("/api/custom_fields/")
    out = _summary(doc, tags, correspondents, types)
    content = doc.get("content") or ""
    out["text"] = content[:MAX_TEXT_CHARS]
    out["text_length"] = len(content)
    out["text_truncated"] = len(content) > MAX_TEXT_CHARS
    out["notes"] = [n.get("note") for n in doc.get("notes", []) if n.get("note")]
    out["custom_fields"] = [
        {"name": fields[f["field"]]["name"], "value": f.get("value")}
        for f in doc.get("custom_fields", [])
        if f.get("field") in fields
    ]
    out["modified"] = doc.get("modified")
    return out


@mcp.tool()
def getDocumentText(document_id: int, offset: int = 0, max_chars: int = MAX_TEXT_CHARS) -> dict:
    """A slice of a document's OCR text, for documents longer than one answer.

    document_id: the id from searchDocuments.
    offset: character to start at. max_chars: at most 20,000.
    """
    doc = _get(f"/api/documents/{document_id}/")
    content = doc.get("content") or ""
    offset = max(0, offset)
    max_chars = max(1, min(max_chars, MAX_TEXT_CHARS))
    chunk = content[offset : offset + max_chars]
    return {
        "id": document_id,
        "offset": offset,
        "text": chunk,
        "text_length": len(content),
        "has_more": offset + len(chunk) < len(content),
    }


@mcp.tool()
def listTags() -> list[dict]:
    """Every tag: id, name, colour, how many documents carry it."""
    return [
        {"id": t["id"], "name": t["name"], "colour": t.get("color"), "document_count": t.get("document_count")}
        for t in _all("/api/tags/")
    ]


@mcp.tool()
def listCorrespondents() -> list[dict]:
    """Every correspondent (the sender or recipient a document is filed under)."""
    return [
        {"id": c["id"], "name": c["name"], "document_count": c.get("document_count")}
        for c in _all("/api/correspondents/")
    ]


@mcp.tool()
def listDocumentTypes() -> list[dict]:
    """Every document type (invoice, letter, contract, ...)."""
    return [
        {"id": d["id"], "name": d["name"], "document_count": d.get("document_count")}
        for d in _all("/api/document_types/")
    ]


@mcp.tool()
def listCustomFields() -> list[dict]:
    """Every custom field a document may carry: id, name, data type, choices."""
    return [
        {
            "id": f["id"],
            "name": f["name"],
            "data_type": f.get("data_type"),
            "extra_data": f.get("extra_data"),
        }
        for f in _all("/api/custom_fields/")
    ]


@mcp.tool()
def getTask(task_id: str) -> dict:
    """The state of a consumption task from uploadDocument: pending, started,
    success (with the new document's id) or failure (with the reason).
    A duplicate of a document already in Paperless is a failure."""
    data = _get("/api/tasks/", {"task_id": task_id})
    results = data.get("results", data) if isinstance(data, dict) else data
    if not results:
        return {"task_id": task_id, "status": "unknown"}
    task = results[0]
    # API version 10 reports a lower-case status and the documents a task
    # produced under related_document_ids; a failure's reason is in
    # result_data.
    related = task.get("related_document_ids") or []
    result = task.get("result_data")
    status = str(task.get("status") or "").lower()
    return {
        "task_id": task_id,
        "status": status,
        "document_id": related[0] if related else None,
        "result": result if isinstance(result, dict) else {"message": result} if result else None,
        "file_name": (task.get("input_data") or {}).get("filename"),
    }


@mcp.tool()
def uploadDocument(
    file_name: str,
    content_base64: str,
    title: str = "",
    tags: list[str] | None = None,
    correspondent: str = "",
    document_type: str = "",
) -> dict:
    """Hand a file (PDF, PNG, JPEG, TIFF, ...) to Paperless for OCR and filing.

    file_name: the name with its extension, which is how the type is told.
    content_base64: the file's bytes, base64-encoded. At most 50 MB.
    tags, correspondent, document_type: names; each must already exist
    (createTag makes a tag). Returns the consumption task's id: ask getTask
    for the document's id once it is through OCR.
    """
    _require_writes()
    try:
        raw = base64.b64decode(content_base64, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("content_base64 is not valid base64") from error
    if not raw:
        raise ValueError("the file is empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValueError(f"the file is {len(raw)} bytes; at most {MAX_UPLOAD_BYTES} are accepted")
    # A multipart form; a list value is sent as one field per item, which
    # is how Paperless takes several tags.
    data: dict[str, Any] = {}
    if title.strip():
        data["title"] = title.strip()
    tag_ids: list[str] = []
    for name in tags or []:
        found = _find("/api/tags/", name)
        if found is None:
            raise ValueError(f"no tag named {name!r}; createTag makes one")
        tag_ids.append(str(found["id"]))
    if tag_ids:
        data["tags"] = tag_ids
    if correspondent.strip():
        found = _find("/api/correspondents/", correspondent.strip())
        if found is None:
            raise ValueError(f"no correspondent named {correspondent!r}")
        data["correspondent"] = str(found["id"])
    if document_type.strip():
        found = _find("/api/document_types/", document_type.strip())
        if found is None:
            raise ValueError(f"no document type named {document_type!r}")
        data["document_type"] = str(found["id"])
    with _client() as client:
        resp = client.post(
            "/api/documents/post_document/",
            data=data,
            files={"document": (os.path.basename(file_name) or "document", raw)},
        )
    resp.raise_for_status()
    task_id = resp.json()
    return {"task_id": task_id, "file_name": file_name, "bytes": len(raw)}


@mcp.tool()
def updateDocument(
    document_id: int,
    title: str = "",
    add_tags: list[str] | None = None,
    remove_tags: list[str] | None = None,
    correspondent: str = "",
    document_type: str = "",
    custom_fields: dict[str, Any] | None = None,
) -> dict:
    """Change a document's filing: its title, tags, correspondent, type, and
    custom field values (by field name). Only what is given changes.

    Names must exist; createTag makes a tag. A custom field's value is given
    in the field's own type (text, a date as YYYY-MM-DD, a number, a boolean).
    """
    _require_writes()
    doc = _get(f"/api/documents/{document_id}/")
    patch: dict[str, Any] = {}
    if title.strip():
        patch["title"] = title.strip()
    if add_tags or remove_tags:
        current = set(doc.get("tags", []))
        for name in add_tags or []:
            found = _find("/api/tags/", name)
            if found is None:
                raise ValueError(f"no tag named {name!r}; createTag makes one")
            current.add(found["id"])
        for name in remove_tags or []:
            found = _find("/api/tags/", name)
            if found is not None:
                current.discard(found["id"])
        patch["tags"] = sorted(current)
    if correspondent.strip():
        found = _find("/api/correspondents/", correspondent.strip())
        if found is None:
            raise ValueError(f"no correspondent named {correspondent!r}")
        patch["correspondent"] = found["id"]
    if document_type.strip():
        found = _find("/api/document_types/", document_type.strip())
        if found is None:
            raise ValueError(f"no document type named {document_type!r}")
        patch["document_type"] = found["id"]
    if custom_fields:
        fields = {f["name"].lower(): f for f in _all("/api/custom_fields/")}
        values = {int(f["field"]): f.get("value") for f in doc.get("custom_fields", [])}
        for name, value in custom_fields.items():
            field = fields.get(str(name).lower())
            if field is None:
                raise ValueError(f"no custom field named {name!r}")
            values[int(field["id"])] = value
        patch["custom_fields"] = [{"field": k, "value": v} for k, v in values.items()]
    if not patch:
        return {"id": document_id, "changed": []}
    with _client() as client:
        resp = client.patch(f"/api/documents/{document_id}/", json=patch)
    resp.raise_for_status()
    return {"id": document_id, "changed": sorted(patch)}


@mcp.tool()
def createTag(name: str) -> dict:
    """Make a tag, or return the one that already has this name."""
    _require_writes()
    found = _find("/api/tags/", name.strip())
    if found is not None:
        return {"id": found["id"], "name": found["name"], "created": False}
    with _client() as client:
        resp = client.post("/api/tags/", json={"name": name.strip()})
    resp.raise_for_status()
    made = resp.json()
    return {"id": made["id"], "name": made["name"], "created": True}


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
