"""What the validators share: where a profile names charts and images, and
whether a registry or chart repository has what it names.

Network answers come in three kinds, and the validators treat them differently:

  FOUND      the registry or index lists it.
  MISSING    the registry or index answered, and it is not there. A definite
             failure: the install would fail the same way.
  UNKNOWN    no definite answer — a timeout, a 5xx, a rate limit, a registry
             that wants credentials before it says anything. A warning, never a
             failure: a transient outage must not turn a pull request red.

Only the standard library and PyYAML: CI installs nothing else for these steps.
"""

from __future__ import annotations

import io
import json
import os
import re
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

import yaml

try:  # The upstream indexes run to megabytes; the C loader reads them in a blink.
    _Loader = yaml.CSafeLoader
except AttributeError:  # pragma: no cover
    _Loader = yaml.SafeLoader

FOUND, MISSING, UNKNOWN = "found", "missing", "unknown"

OFFLINE = os.environ.get("VALIDATE_OFFLINE", "") not in ("", "0", "false")

_MANIFEST_ACCEPT = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)
_TIMEOUT = 30
_ATTEMPTS = 3


@dataclass
class Answer:
    state: str
    detail: str = ""


class _Transient(Exception):
    pass


def _request(url: str, *, method: str = "GET", headers: dict | None = None):
    """(status, headers, body) for url; non-2xx is returned, not raised.

    Network errors, 5xx and 429 are retried, then raised as _Transient.
    """
    last = ""
    for attempt in range(_ATTEMPTS):
        if attempt:
            time.sleep(2**attempt)
        req = urllib.request.Request(url, method=method, headers=headers or {})
        req.add_header("User-Agent", "gentian-apps-validators")
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as err:
            if err.code == 429 or err.code >= 500:
                last = f"HTTP {err.code} from {url}"
                continue
            return err.code, err.headers, err.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
            last = f"{url}: {err}"
    raise _Transient(last)


# --------------------------------------------------------------------------
# Chart repositories
# --------------------------------------------------------------------------

_index_cache: dict[str, dict] = {}


def _helm_index(repository: str) -> dict:
    base = repository.rstrip("/")
    if base not in _index_cache:
        status, _, body = _request(f"{base}/index.yaml")
        if status != 200:
            # A repository without an index is as definite as an index
            # without the chart — but a 401/403 may only mean "log in".
            if status in (401, 403):
                raise _Transient(f"{base}/index.yaml answered HTTP {status}")
            _index_cache[base] = {"__status__": status}
        else:
            _index_cache[base] = yaml.load(body, Loader=_Loader) or {}
    return _index_cache[base]


def helm_chart(repository: str, name: str, version: str) -> Answer:
    """Does the https chart repository list name at version?"""
    if OFFLINE:
        return Answer(UNKNOWN, "offline")
    try:
        index = _helm_index(repository)
    except _Transient as err:
        return Answer(UNKNOWN, str(err))
    if "__status__" in index:
        return Answer(MISSING, f"{repository} has no index.yaml (HTTP {index['__status__']})")
    entries = (index.get("entries") or {}).get(name)
    if not entries:
        return Answer(MISSING, f"{repository}/index.yaml lists no chart named {name!r}")
    versions = [str(e.get("version")) for e in entries]
    if str(version) not in versions:
        recent = ", ".join(versions[:5])
        return Answer(
            MISSING, f"{repository}/index.yaml lists {name!r} but not version {version} (newest: {recent})"
        )
    return Answer(FOUND)


def helm_chart_values(repository: str, name: str, version: str) -> dict | None:
    """The chart's own values.yaml, or None if it cannot be had."""
    if OFFLINE:
        return None
    try:
        if repository.startswith("oci://"):
            ref = repository[len("oci://") :].rstrip("/") + f"/{name}:{version}"
            blob = _oci_chart_blob(ref)
        else:
            index = _helm_index(repository)
            entry = next(
                (e for e in (index.get("entries") or {}).get(name) or [] if str(e.get("version")) == str(version)),
                None,
            )
            if not entry or not entry.get("urls"):
                return None
            url = urllib.parse.urljoin(repository.rstrip("/") + "/", entry["urls"][0])
            status, _, blob = _request(url)
            if status != 200:
                return None
        if not blob:
            return None
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tar:
            member = next((m for m in tar.getmembers() if m.name == f"{name}/values.yaml"), None)
            if member is None:
                return None
            return yaml.safe_load(tar.extractfile(member).read()) or {}
    except (_Transient, tarfile.TarError, yaml.YAMLError, KeyError, ValueError):
        return None


# --------------------------------------------------------------------------
# OCI registries (images and OCI charts)
# --------------------------------------------------------------------------


@dataclass
class ImageRef:
    registry: str  # host as pulled from, e.g. registry-1.docker.io
    repository: str  # path, e.g. library/python
    reference: str  # tag or digest
    shown: str  # as the profile wrote it


def parse_image(ref: str) -> ImageRef | None:
    """Split an image reference the way a container runtime does."""
    ref = ref.strip()
    if not ref or "${" in ref:
        return None
    if "@" in ref:
        name, reference = ref.split("@", 1)
    else:
        slash = ref.rfind("/")
        colon = ref.rfind(":")
        if colon > slash:
            name, reference = ref[:colon], ref[colon + 1 :]
        else:
            name, reference = ref, "latest"
    first, _, rest = name.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        registry, repository = first, rest
    else:
        registry, repository = "docker.io", name
    if registry == "docker.io":
        registry = "registry-1.docker.io"
        if "/" not in repository:
            repository = f"library/{repository}"
    return ImageRef(registry, repository, reference, ref)


def _bearer_token(challenge: str, repository: str) -> str | None:
    """An anonymous pull token for a Bearer challenge, or None."""
    params = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    realm = params.get("realm")
    if not realm:
        return None
    query = {"scope": f"repository:{repository}:pull"}
    if params.get("service"):
        query["service"] = params["service"]
    status, _, body = _request(f"{realm}?{urllib.parse.urlencode(query)}")
    if status != 200:
        return None
    data = json.loads(body or b"{}")
    return data.get("token") or data.get("access_token")


def _registry_get(ref: ImageRef, path: str, *, method: str, accept: str):
    url = f"https://{ref.registry}/v2/{ref.repository}/{path}"
    headers = {"Accept": accept}
    status, hdrs, body = _request(url, method=method, headers=headers)
    if status == 401:
        challenge = (hdrs or {}).get("WWW-Authenticate", "")
        if challenge.lower().startswith("bearer"):
            token = _bearer_token(challenge, ref.repository)
            if token is None:
                return 401, hdrs, b""
            headers["Authorization"] = f"Bearer {token}"
            status, hdrs, body = _request(url, method=method, headers=headers)
    return status, hdrs, body


def _docker_hub_tag(ref: ImageRef) -> Answer:
    """Docker Hub answers 401, not 404, for a repository that does not exist;
    its own API says which it is."""
    namespace, _, repo = ref.repository.partition("/")
    url = f"https://hub.docker.com/v2/namespaces/{namespace}/repositories/{repo}/tags/{ref.reference}"
    status, _, _ = _request(url)
    if status == 200:
        return Answer(FOUND)
    if status == 404:
        return Answer(MISSING, f"Docker Hub has no {ref.repository}:{ref.reference}")
    return Answer(UNKNOWN, f"Docker Hub API answered HTTP {status}")


def image_exists(ref: ImageRef, *, owned: bool = False) -> Answer:
    """Does the registry have a manifest for ref?

    owned: the repository is one of ours and public, so a registry that
    refuses an anonymous pull is saying it does not exist (ghcr.io answers
    403 rather than 404 for a repository it has never seen).
    """
    if OFFLINE:
        return Answer(UNKNOWN, "offline")
    try:
        status, _, _ = _registry_get(ref, f"manifests/{ref.reference}", method="HEAD", accept=_MANIFEST_ACCEPT)
        if 200 <= status < 300:
            return Answer(FOUND)
        if status == 404:
            return Answer(MISSING, f"{ref.registry} has no manifest {ref.repository}:{ref.reference}")
        if status in (401, 403):
            if ref.registry == "registry-1.docker.io":
                return _docker_hub_tag(ref)
            if owned:
                return Answer(
                    MISSING,
                    f"{ref.registry} refuses an anonymous pull of {ref.repository}: it does not exist "
                    f"(this organisation's packages are public)",
                )
            return Answer(UNKNOWN, f"{ref.registry} wants credentials for {ref.repository} (HTTP {status})")
        return Answer(UNKNOWN, f"{ref.registry} answered HTTP {status} for {ref.repository}:{ref.reference}")
    except _Transient as err:
        return Answer(UNKNOWN, str(err))


def _oci_chart_blob(ref_text: str) -> bytes | None:
    ref = parse_image(ref_text)
    if ref is None:
        return None
    status, _, body = _registry_get(
        ref, f"manifests/{ref.reference}", method="GET", accept="application/vnd.oci.image.manifest.v1+json"
    )
    if status != 200:
        return None
    manifest = json.loads(body)
    layer = next(
        (
            layer
            for layer in manifest.get("layers") or []
            if layer.get("mediaType") == "application/vnd.cncf.helm.chart.content.v1.tar+gzip"
        ),
        None,
    )
    if not layer:
        return None
    status, _, blob = _registry_get(ref, f"blobs/{layer['digest']}", method="GET", accept="*/*")
    return blob if status == 200 else None


def oci_chart(repository: str, name: str, version: str, *, owned: bool = False) -> Answer:
    """Does oci://<repository>/<name>:<version> exist?"""
    ref = parse_image(repository[len("oci://") :].rstrip("/") + f"/{name}:{version}")
    if ref is None:
        return Answer(UNKNOWN, "unparseable reference")
    return image_exists(ref, owned=owned)


# --------------------------------------------------------------------------
# Where a profile names charts and images
# --------------------------------------------------------------------------


def chart_uses(spec: dict) -> list[tuple[str, dict, dict]]:
    """(where, chart, extraValues) for the package chart and every extension's."""
    uses: list[tuple[str, dict, dict]] = []
    package = spec.get("package") or {}
    if isinstance(package.get("chart"), dict):
        uses.append(("spec.package.chart", package["chart"], package.get("extraValues") or {}))
    for i, ext in enumerate(spec.get("extensions") or []):
        if isinstance(ext, dict) and isinstance(ext.get("chart"), dict):
            uses.append((f"spec.extensions[{i}].chart", ext["chart"], ext.get("extraValues") or {}))
    return uses
