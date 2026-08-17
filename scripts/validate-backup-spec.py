#!/usr/bin/env python3
"""Check that spec.backup declarations are ones the platform can actually honour.

Nothing else catches a mistake here. The CRD schema constrains enums and the
OpenBao path shape, but a profile is never validated against the CRD in this
repo -- `kubectl kustomize` renders the bundle without schema-checking it, and
the API server prunes unknown fields silently on sync. So a `quiesce.pre` typed
as a shell string instead of an argv, or an `excludePaths` entry that drops the
config file holding the key the data was encrypted with, would be accepted here
and only surface during a restore, which is the worst possible moment to learn
about it.

The checks below are therefore the ones whose failure mode is silent data loss
or an app left paused, not stylistic preferences.

See gentian-os/docs/plans/backup-plan.md §5 for the contract.
"""

from __future__ import annotations

import pathlib
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent

QUIESCE_MODES = {"none", "scaleDown", "command"}
CONSISTENCY_MODES = {"app", "perStore"}

# Excluding any of these from a captured volume discards something the data
# cannot be read back without. Matched as a path segment, case-insensitively.
PROTECTED_PATH_HINTS = ("config", "secret", "key", "cert")


def _is_argv(value: object) -> bool:
    """An argv is a non-empty list of strings.

    A shell string ("occ maintenance:mode --on") is the tempting mistake: it is
    valid YAML, reads naturally, and would be exec'd as a single binary whose
    name contains spaces. It fails at capture time, on a live tenant.
    """
    return (
        isinstance(value, list)
        and len(value) > 0
        and all(isinstance(item, str) and item != "" for item in value)
    )


def check_quiesce(where: str, quiesce: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(quiesce, dict):
        return [f"{where}: backup.quiesce must be a mapping"]

    mode = quiesce.get("mode", "scaleDown")
    if mode not in QUIESCE_MODES:
        errors.append(
            f"{where}: backup.quiesce.mode {mode!r} is not one of "
            f"{sorted(QUIESCE_MODES)}"
        )

    for field in ("pre", "post"):
        if field in quiesce and not _is_argv(quiesce[field]):
            errors.append(
                f"{where}: backup.quiesce.{field} must be a non-empty list of "
                f"strings (argv), not {quiesce[field]!r}. The first element is "
                f"the binary; a shell line would be exec'd as one filename."
            )

    if mode == "command":
        if "pre" not in quiesce:
            errors.append(
                f"{where}: backup.quiesce.mode is 'command' but no pre command "
                f"is declared, so nothing would pause writes."
            )
        if "post" not in quiesce:
            # Worse than a missing pre: the app stays in maintenance mode.
            errors.append(
                f"{where}: backup.quiesce.mode is 'command' with a pre but no "
                f"post command -- the app would stay paused after the capture."
            )
    else:
        if "pre" in quiesce or "post" in quiesce:
            errors.append(
                f"{where}: backup.quiesce declares pre/post but mode is {mode!r}; "
                f"those commands would never run. Set mode: command."
            )

    return errors


def check_volumes(where: str, volumes: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(volumes, dict):
        return [f"{where}: backup.volumes must be a mapping"]

    include = volumes.get("include")
    if include is not None and not _is_argv(include):
        errors.append(
            f"{where}: backup.volumes.include must be a non-empty list of "
            f"claim names; omit it to capture every release-owned volume."
        )

    excludes = volumes.get("excludePaths")
    if excludes is not None:
        if not _is_argv(excludes):
            errors.append(
                f"{where}: backup.volumes.excludePaths must be a non-empty list "
                f"of glob patterns."
            )
        else:
            for pattern in excludes:
                segments = [s.lower() for s in pattern.strip("/").split("/")]
                for hint in PROTECTED_PATH_HINTS:
                    if any(hint in segment for segment in segments):
                        errors.append(
                            f"{where}: backup.volumes.excludePaths entry "
                            f"{pattern!r} looks like it drops configuration or "
                            f"key material. An app whose config file holds the "
                            f"key its data was encrypted with becomes "
                            f"unrestorable, and nothing detects it until a "
                            f"restore. Narrow the pattern, or exclude only "
                            f"derived data."
                        )
                        break

    return errors


def check_bound_secrets(where: str, bound: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(bound, list):
        return [f"{where}: backup.boundSecrets must be a list"]

    for entry in bound:
        if not isinstance(entry, dict):
            errors.append(f"{where}: backup.boundSecrets entries must be mappings")
            continue

        path = entry.get("openBaoPath")
        if not isinstance(path, str) or not path:
            errors.append(f"{where}: backup.boundSecrets entry needs an openBaoPath")
            continue

        # The path is resolved under gentian-os/tenants/{tenant}/. Anything that
        # escapes that prefix would let one profile name another tenant's
        # secrets and pull them into this tenant's bundle.
        if path.startswith("/"):
            errors.append(
                f"{where}: backup.boundSecrets openBaoPath {path!r} is absolute; "
                f"it must be relative to the tenant prefix."
            )
        if ".." in path.split("/"):
            errors.append(
                f"{where}: backup.boundSecrets openBaoPath {path!r} contains '..' "
                f"and would escape the tenant's own subtree."
            )

        keys = entry.get("keys")
        if keys is not None and not _is_argv(keys):
            errors.append(
                f"{where}: backup.boundSecrets keys must be a non-empty list of "
                f"strings; omit it to capture every key at that path."
            )

    return errors


def check_restore(where: str, restore: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(restore, dict):
        return [f"{where}: backup.restore must be a mapping"]

    post = restore.get("post")
    if post is not None:
        if not isinstance(post, list) or not post:
            errors.append(f"{where}: backup.restore.post must be a non-empty list")
        else:
            for command in post:
                if not _is_argv(command):
                    errors.append(
                        f"{where}: backup.restore.post entry {command!r} must be "
                        f"an argv (a list of strings), not a shell line."
                    )

    verify = restore.get("verify")
    if verify is not None and not _is_argv(verify):
        errors.append(
            f"{where}: backup.restore.verify must be an argv (a list of strings)."
        )

    return errors


def check_backup(where: str, backup: object) -> list[str]:
    if not isinstance(backup, dict):
        return [f"{where}: spec.backup must be a mapping"]

    errors: list[str] = []

    consistency = backup.get("consistency", "app")
    if consistency not in CONSISTENCY_MODES:
        errors.append(
            f"{where}: backup.consistency {consistency!r} is not one of "
            f"{sorted(CONSISTENCY_MODES)}"
        )

    if "quiesce" in backup:
        errors.extend(check_quiesce(where, backup["quiesce"]))
    if "volumes" in backup:
        errors.extend(check_volumes(where, backup["volumes"]))
    if "boundSecrets" in backup:
        errors.extend(check_bound_secrets(where, backup["boundSecrets"]))
    if "restore" in backup:
        errors.extend(check_restore(where, backup["restore"]))

    return errors


def main() -> int:
    errors: list[str] = []
    declared = 0

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        doc = yaml.safe_load(path.read_text())
        if not isinstance(doc, dict):
            continue

        spec = doc.get("spec") or {}
        backup = spec.get("backup")
        if backup is None:
            # The overwhelmingly common case, and a correct one: the platform
            # default (scale to zero, dump every declared store, archive every
            # release-owned volume) covers most apps.
            continue

        declared += 1
        name = (doc.get("metadata") or {}).get("name") or path.parent.name
        errors.extend(check_backup(f"{path.relative_to(REPO)} ({name})", backup))

    if errors:
        print("Backup contract errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"Checked {declared} spec.backup declaration(s). All are honourable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
