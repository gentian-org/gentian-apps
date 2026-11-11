"""Tools over Odoo's JSON-2 API, described by tool packs.

A tool pack is a YAML file for one Odoo module. Each tool in it names a model,
one operation on it, a fixed domain that bounds the records it may touch, the
only fields it may read or write, and its inputs. This module reads packs,
turns a tool and its arguments into JSON-2 calls, and makes them with the
credential the caller sent. It holds no credential of its own: what a call may
do is what Odoo lets the token's owner do.

Operations:
  search  search_read within the domain; inputs `match` (any of the paths,
          case-insensitive substring), `equals` (one path, exact) and `limit`
  read    one record by its id (`target`), within the domain
  create  one record from the inputs that name a `field`, plus fixed `values`
  write   the inputs that name a `field`, on one record within the domain
  call    a public method on one record within the domain: the inputs that
          name an `argument`, plus fixed `arguments`
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

CLASSES = ("read", "change", "irreversible")
OPERATIONS = ("search", "read", "create", "write", "call")
TYPES = {
    "string": {"type": "string"},
    "text": {"type": "string"},
    "integer": {"type": "integer"},
    "number": {"type": "number"},
    "boolean": {"type": "boolean"},
    "date": {"type": "string", "format": "date"},
    "integers": {"type": "array", "items": {"type": "integer"}},
}
ROLES = ("match", "equals", "field", "target", "argument", "limit")
NAME = re.compile(r"^[a-z][a-z0-9-]*[a-z0-9]$")
INPUT = re.compile(r"^[a-z][a-z0-9_]*$")
FIELD = re.compile(r"^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)*$")
MAX_LIMIT = 200


class PackError(ValueError):
    """A tool pack that cannot be used as written."""


class ToolError(Exception):
    """A call that failed, in words for the caller."""


@dataclass(frozen=True)
class Input:
    name: str
    type: str
    description: str
    required: bool
    role: str
    # What the role works on: the paths of a match, the path of an equals, the
    # field of a field, the argument of an argument.
    target: tuple[str, ...] = ()
    default: int | None = None
    maximum: int | None = None

    def schema(self) -> dict[str, Any]:
        out = dict(TYPES[self.type])
        out["description"] = self.description
        if self.role == "limit":
            out["minimum"] = 1
            out["maximum"] = self.maximum
            out["default"] = self.default
        return out


@dataclass(frozen=True)
class Tool:
    module: str
    name: str
    version: int
    cls: str
    description: str
    model: str
    operation: str
    domain: tuple = ()
    fields: tuple[str, ...] = ()
    method: str | None = None
    values: dict[str, Any] = field(default_factory=dict)
    arguments: dict[str, Any] = field(default_factory=dict)
    inputs: tuple[Input, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.name}.v{self.version}"

    def input_schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {i.name: i.schema() for i in self.inputs},
            "required": [i.name for i in self.inputs if i.required],
            "additionalProperties": False,
        }


def _fail(where: str, why: str) -> PackError:
    return PackError(f"{where}: {why}")


def _input(where: str, name: str, raw: dict[str, Any], operation: str) -> Input:
    if not INPUT.match(name):
        raise _fail(where, f"input {name!r} is not a lower-case name with underscores")
    if not isinstance(raw, dict):
        raise _fail(where, f"input {name!r} is not a mapping")
    roles = [r for r in ROLES if r in raw]
    if len(roles) != 1:
        raise _fail(where, f"input {name!r} needs exactly one of {', '.join(ROLES)}")
    role = roles[0]
    allowed = {
        "search": {"match", "equals", "limit"},
        "read": {"target"},
        "create": {"field"},
        "write": {"target", "field"},
        "call": {"target", "argument"},
    }[operation]
    if role not in allowed:
        raise _fail(where, f"input {name!r}: {role} has no meaning for {operation}")
    kind = raw.get("type", "integer" if role in ("target", "limit") else "string")
    if kind not in TYPES:
        raise _fail(where, f"input {name!r} has type {kind!r}, not one of {', '.join(TYPES)}")
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        raise _fail(where, f"input {name!r} has no description")

    target: tuple[str, ...] = ()
    if role == "match":
        paths = raw["match"]
        if not isinstance(paths, list) or not paths:
            raise _fail(where, f"input {name!r}: match is a list of field paths")
        target = tuple(paths)
    elif role in ("equals", "field", "argument"):
        if not isinstance(raw[role], str):
            raise _fail(where, f"input {name!r}: {role} names one field")
        target = (raw[role],)
    elif raw[role] is not True:
        raise _fail(where, f"input {name!r}: {role} is true or absent")
    for path in target:
        if not FIELD.match(path):
            raise _fail(where, f"input {name!r}: {path!r} is not a field path")

    default = maximum = None
    if role == "limit":
        if kind != "integer":
            raise _fail(where, f"input {name!r}: a limit is an integer")
        default = int(raw.get("default", 20))
        maximum = int(raw.get("maximum", 100))
        if not 1 <= default <= maximum <= MAX_LIMIT:
            raise _fail(where, f"input {name!r}: needs 1 <= default <= maximum <= {MAX_LIMIT}")
    if role == "target" and kind != "integer":
        raise _fail(where, f"input {name!r}: a target is a record id, an integer")
    required = bool(raw.get("required", role == "target"))
    if role == "target" and not required:
        raise _fail(where, f"input {name!r}: a target is always required")
    return Input(name, kind, description.strip(), required, role, target, default, maximum)


def _tool(module: str, where: str, raw: dict[str, Any]) -> Tool:
    if not isinstance(raw, dict):
        raise _fail(where, "a tool is a mapping")
    name = raw.get("name")
    if not isinstance(name, str) or not NAME.match(name):
        raise _fail(where, "name is a lower-case name with dashes")
    where = f"{where} ({name})"
    version = raw.get("version")
    if not isinstance(version, int) or version < 1:
        raise _fail(where, "version is a whole number from 1")
    cls = raw.get("class")
    if cls not in CLASSES:
        raise _fail(where, f"class is one of {', '.join(CLASSES)}")
    operation = raw.get("operation")
    if operation not in OPERATIONS:
        raise _fail(where, f"operation is one of {', '.join(OPERATIONS)}")
    if cls == "read" and operation not in ("search", "read"):
        raise _fail(where, f"a read tool cannot {operation}")
    if cls != "read" and operation in ("search", "read"):
        raise _fail(where, f"a tool that only reads is class read, not {cls}")
    model = raw.get("model")
    if not isinstance(model, str) or not re.match(r"^[a-z][a-z0-9_.]*$", model):
        raise _fail(where, "model is an Odoo model name")
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        raise _fail(where, "it has no description")
    domain = raw.get("domain", [])
    if not isinstance(domain, list):
        raise _fail(where, "domain is a list")
    if operation == "create" and domain:
        raise _fail(where, "a create has no domain: use values")
    fields = raw.get("fields", [])
    if operation in ("search", "read"):
        if not fields or not all(isinstance(f, str) and FIELD.match(f) for f in fields):
            raise _fail(where, "fields lists the fields the answer carries")
    elif fields:
        raise _fail(where, "fields is for search and read; a write names its fields on its inputs")
    method = raw.get("method")
    if operation == "call":
        if not isinstance(method, str) or not re.match(r"^[a-z][a-z0-9_]*$", method):
            raise _fail(where, "a call names a public method")
    elif method is not None:
        raise _fail(where, "method is for call")
    values = raw.get("values", {})
    if values and operation != "create":
        raise _fail(where, "values is for create")
    arguments = raw.get("arguments", {})
    if arguments and operation != "call":
        raise _fail(where, "arguments is for call")
    if not isinstance(values, dict) or not isinstance(arguments, dict):
        raise _fail(where, "values and arguments are mappings")

    raw_inputs = raw.get("inputs", {}) or {}
    if not isinstance(raw_inputs, dict):
        raise _fail(where, "inputs is a mapping of name to input")
    inputs = tuple(_input(where, n, r, operation) for n, r in raw_inputs.items())
    roles = [i.role for i in inputs]
    if operation in ("read", "write", "call") and roles.count("target") != 1:
        raise _fail(where, f"a {operation} has exactly one target input")
    if roles.count("limit") > 1:
        raise _fail(where, "at most one limit input")
    if operation in ("create", "write") and "field" not in roles:
        raise _fail(where, f"a {operation} has at least one field input")
    written = [i.target[0] for i in inputs if i.role == "field"] + list(values)
    if len(written) != len(set(written)):
        raise _fail(where, "a field is written by one input or value, not two")
    passed = [i.target[0] for i in inputs if i.role == "argument"] + list(arguments)
    if len(passed) != len(set(passed)) or "ids" in passed or "context" in passed:
        raise _fail(where, "an argument is passed once, and never ids or context")
    return Tool(
        module=module,
        name=name,
        version=version,
        cls=cls,
        description=description.strip(),
        model=model,
        operation=operation,
        domain=tuple(_freeze(domain)),
        fields=tuple(fields),
        method=method,
        values=values,
        arguments=arguments,
        inputs=inputs,
    )


def _freeze(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(_freeze(v) for v in value)
    return value


def _thaw(value: Any) -> Any:
    if isinstance(value, tuple):
        return [_thaw(v) for v in value]
    return value


def load_pack(path: Path) -> list[Tool]:
    """The tools of one pack file, or PackError."""
    where = path.name
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise _fail(where, f"does not parse: {exc}") from exc
    if not isinstance(raw, dict):
        raise _fail(where, "a pack is a mapping")
    module = raw.get("module")
    if not isinstance(module, str) or not re.match(r"^[a-z][a-z0-9_]*$", module):
        raise _fail(where, "module is the Odoo module the tools need")
    tools = raw.get("tools")
    if not isinstance(tools, list) or not tools:
        raise _fail(where, "tools lists at least one tool")
    return [_tool(module, f"{where} tool {n + 1}", t) for n, t in enumerate(tools)]


def load_packs(directory: Path) -> list[Tool]:
    """Every tool of every pack in a directory. A tool key is offered once."""
    out: list[Tool] = []
    seen: dict[str, str] = {}
    for path in sorted(directory.glob("*.yaml")):
        for tool in load_pack(path):
            if tool.key in seen:
                raise PackError(f"{path.name}: {tool.key} is also in {seen[tool.key]}")
            seen[tool.key] = path.name
            out.append(tool)
    return out


def active(tools: list[Tool], modules: set[str] | None) -> list[Tool]:
    """The tools whose module is active. None means every module."""
    if modules is None:
        return list(tools)
    return [t for t in tools if t.module in modules]


# --- From a tool and its arguments to JSON-2 calls ---------------------------


@dataclass(frozen=True)
class Call:
    model: str
    method: str
    body: dict[str, Any]


def _target(tool: Tool, args: dict[str, Any]) -> int:
    (name,) = [i.name for i in tool.inputs if i.role == "target"]
    value = args[name]
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ToolError(f"{name} is a record id, a whole number from 1")
    return value


def _check(tool: Tool, args: dict[str, Any]) -> None:
    known = {i.name for i in tool.inputs}
    unknown = sorted(set(args) - known)
    if unknown:
        raise ToolError(f"{tool.key} takes no {', '.join(unknown)}")
    missing = [i.name for i in tool.inputs if i.required and args.get(i.name) in (None, "")]
    if missing:
        raise ToolError(f"{tool.key} needs {', '.join(missing)}")


def plan(tool: Tool, args: dict[str, Any]) -> list[Call]:
    """The JSON-2 calls a tool makes, in order. The first of a write or a call
    finds the target within the tool's domain; the caller stops when it finds
    nothing."""
    _check(tool, args)
    domain = _thaw(tool.domain)
    given = {i.name: args[i.name] for i in tool.inputs if args.get(i.name) not in (None, "")}

    if tool.operation == "search":
        terms: list[Any] = list(domain)
        limit = None
        for i in tool.inputs:
            if i.name not in given:
                if i.role == "limit":
                    limit = i.default
                continue
            value = given[i.name]
            if i.role == "limit":
                limit = max(1, min(int(value), i.maximum or MAX_LIMIT))
            elif i.role == "equals":
                terms.append([i.target[0], "=", value])
            elif i.role == "match":
                ors = [[p, "ilike", value] for p in i.target]
                terms.extend(["|"] * (len(ors) - 1) + ors)
        body = {"domain": terms, "fields": list(tool.fields), "order": "id desc"}
        if limit is not None:
            body["limit"] = limit
        return [Call(tool.model, "search_read", body)]

    if tool.operation == "create":
        vals = dict(tool.values)
        vals.update({i.target[0]: given[i.name] for i in tool.inputs if i.role == "field" and i.name in given})
        return [Call(tool.model, "create", {"vals_list": [vals]})]

    record = _target(tool, args)
    find = Call(tool.model, "search", {"domain": [["id", "=", record], *domain], "limit": 1})
    if tool.operation == "read":
        return [Call(tool.model, "search_read", {"domain": find.body["domain"], "fields": list(tool.fields), "limit": 1})]
    if tool.operation == "write":
        vals = {i.target[0]: given[i.name] for i in tool.inputs if i.role == "field" and i.name in given}
        if not vals:
            raise ToolError(f"{tool.key}: give at least one value to change")
        return [find, Call(tool.model, "write", {"ids": [record], "vals": vals})]
    kwargs = dict(tool.arguments)
    kwargs.update({i.target[0]: given[i.name] for i in tool.inputs if i.role == "argument" and i.name in given})
    return [find, Call(tool.model, tool.method or "", {"ids": [record], **kwargs})]


# --- Making the calls --------------------------------------------------------


class Odoo:
    """Odoo's JSON-2 API, called with the caller's credential."""

    def __init__(self, url: str, database: str | None = None, timeout: float = 30.0,
                 transport: httpx.BaseTransport | None = None):
        self.url = url.rstrip("/")
        self.database = database
        self.timeout = timeout
        self.transport = transport

    def _post(self, client: httpx.Client, call: Call) -> Any:
        try:
            resp = client.post(f"/json/2/{call.model}/{call.method}", json=call.body)
        except httpx.HTTPError as exc:
            raise ToolError(f"Odoo did not answer: {exc.__class__.__name__}") from exc
        if resp.status_code == 401:
            raise ToolError("Odoo refused the credential this call carried")
        if resp.status_code == 403:
            raise ToolError(f"Odoo does not let this person {call.method} {call.model}: {_message(resp)}")
        if resp.status_code == 404:
            raise ToolError(f"Odoo has no {call.model}.{call.method}: is its module installed? {_message(resp)}")
        if resp.status_code >= 400:
            raise ToolError(f"Odoo refused {call.model}.{call.method} ({resp.status_code}): {_message(resp)}")
        try:
            return resp.json()
        except ValueError as exc:
            raise ToolError(f"Odoo answered {call.model}.{call.method} with something that is not JSON") from exc

    def run(self, tool: Tool, args: dict[str, Any], authorization: str) -> Any:
        """Make a tool's calls as the owner of `authorization`, and shape the answer."""
        if not authorization.lower().startswith("bearer ") or not authorization[7:].strip():
            raise ToolError("this call carries no bearer credential for Odoo")
        calls = plan(tool, args)
        headers = {"Authorization": authorization}
        if self.database:
            headers["X-Odoo-Database"] = self.database
        with httpx.Client(base_url=self.url, headers=headers, timeout=self.timeout,
                          transport=self.transport) as client:
            if tool.operation in ("write", "call"):
                found = self._post(client, calls[0])
                if not found:
                    raise ToolError(f"no {tool.model} {calls[1].body['ids'][0]} that this tool may change")
                calls = calls[1:]
            result = self._post(client, calls[0])

        if tool.operation == "search":
            return {"records": result, "count": len(result)}
        if tool.operation == "read":
            if not result:
                raise ToolError(f"no {tool.model} {_target(tool, args)} that this tool may read")
            return {"record": result[0]}
        if tool.operation == "create":
            ids = result if isinstance(result, list) else [result]
            return {"id": ids[0] if ids else None}
        if tool.operation == "write":
            return {"id": _target(tool, args), "changed": sorted(calls[0].body["vals"])}
        return {"id": _target(tool, args), "result": result}


def _message(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return resp.text[:300]
    if isinstance(body, dict):
        return str(body.get("message") or body.get("name") or body)[:300]
    return str(body)[:300]
