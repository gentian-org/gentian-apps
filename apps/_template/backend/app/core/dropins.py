"""Read L1 drop-in configuration fragments.

Implements the precedence chain from gentian-os/docs/app-customization.md §2.2:

    image defaults
      -> chart values.yaml
        -> AppProfile.spec.extraValues
          -> profile drop-ins        (50-89 prefixes)
            -> Tenant extraValues
              -> tenant drop-ins     (90-99 prefixes)   <- highest

Within the drop-in directory files apply in lexicographic order, exactly like
systemd's ``*.conf.d``. The numeric prefix is not decoration: it is what keeps a
tenant from silently outranking a platform default. The operator enforces the
range on write; this module enforces the ordering on read.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

#: Where the chart mounts drop-in ConfigMaps. Override per app.
DEFAULT_DROPIN_DIR = "/etc/gentian/app/conf.d"

#: Environment variable the chart sets so the path is not hard-coded in code.
DROPIN_DIR_ENV = "GENTIAN_DROPIN_DIR"


def dropin_dir() -> Path:
    return Path(os.environ.get(DROPIN_DIR_ENV, DEFAULT_DROPIN_DIR))


def deep_merge(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge ``overlay`` over ``base``.

    Mappings merge; every other type replaces. Lists replace rather than append —
    appending would make it impossible for a later layer to *remove* an entry,
    which is the more common need in practice.
    """
    result = dict(base)
    for key, value in overlay.items():
        existing = result.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            result[key] = deep_merge(existing, value)
        else:
            result[key] = value
    return result


def load_dropins(directory: Path | None = None) -> dict[str, Any]:
    """Load and merge every YAML fragment in the drop-in directory, in order.

    A malformed fragment is logged and skipped rather than raising: the operator
    validates content before mounting it, so anything malformed here arrived by a
    path that bypassed validation, and failing the whole app for it would turn a
    misconfiguration into an outage.
    """
    path = directory or dropin_dir()
    if not path.is_dir():
        return {}

    merged: dict[str, Any] = {}
    for fragment in sorted(path.iterdir()):
        if not fragment.is_file() or fragment.suffix not in {".yaml", ".yml"}:
            continue
        try:
            content = yaml.safe_load(fragment.read_text()) or {}
        except yaml.YAMLError as exc:
            logger.error("skipping malformed drop-in %s: %s", fragment.name, exc)
            continue
        if not isinstance(content, dict):
            logger.error("skipping drop-in %s: expected a mapping", fragment.name)
            continue
        merged = deep_merge(merged, content)
        logger.info("applied drop-in %s", fragment.name)

    return merged


def describe_dropins(directory: Path | None = None) -> list[dict[str, Any]]:
    """List the applied fragments, for the diagnostics endpoint.

    Being able to answer "why is this setting what it is" without shelling into a
    pod is what stops people reaching for a cluster hotfix.
    """
    path = directory or dropin_dir()
    if not path.is_dir():
        return []
    return [
        {"name": fragment.name, "bytes": fragment.stat().st_size}
        for fragment in sorted(path.iterdir())
        if fragment.is_file() and fragment.suffix in {".yaml", ".yml"}
    ]
