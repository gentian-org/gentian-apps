# Nextcloud — OS follow-ups

`spec.provisioning.privilegedRole` (group `admin`) is declared in `profile.yaml`, but gentian-os no longer syncs app-admins into Nextcloud after the hardcoded `nextcloud` branch was removed from `app_privilege_reconciler`.

**Needed in gentian-os:** generic privileged-role provider driven by `AppProfile.spec.provisioning.privilegedRole` (OCS group sync via `internal/provisioning/nextcloud`, service URL from `fullnameOverride: nextcloud`, credentials from tenant app secrets). No profile-name switch.
