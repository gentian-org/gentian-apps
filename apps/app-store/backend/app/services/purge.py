from __future__ import annotations

import time
from typing import Any

from kubernetes import client
from kubernetes.client.rest import ApiException
from kubernetes.stream import stream

KERNEL_NAMESPACE = "platform-kernel"
GENTIAN_SYSTEM_NAMESPACE = "gentian-system"
OPENBAO_NAMESPACE = "openbao"
GENTIAN_OS_SA = "gentian-os"
MANAGED_BY_LABEL = "app.kubernetes.io/managed-by=gentian-os"


class PurgeError(Exception):
    pass


def _db_role_name(tenant: str, app: str) -> str:
    return f"{tenant}_{app}".replace("-", "_")


def _database_name(tenant_cr: dict[str, Any], app: str) -> str:
    prefix = tenant_cr.get("spec", {}).get("isolation", {}).get("databasePrefix") or f"{tenant_cr['metadata']['name']}_"
    return f"{prefix.replace('-', '_')}{app.replace('-', '_')}"


def _mariadb_user_name(tenant: str, app: str) -> str:
    return f"{tenant}_{app}".replace("-", "_")


def _s3_safe_component(value: str) -> str:
    out: list[str] = []
    for ch in value:
        if ch.islower() or ch.isdigit() or ch == "-":
            out.append(ch)
        elif ch.isupper():
            out.append(ch.lower())
        else:
            out.append("-")
    return "".join(out)


def _s3_bucket_name(tenant_cr: dict[str, Any], app: str) -> str:
    tenant = tenant_cr["metadata"]["name"]
    prefix = tenant_cr.get("spec", {}).get("isolation", {}).get("s3Prefix") or f"{tenant}-"
    return f"{_s3_safe_component(prefix)}{_s3_safe_component(app)}"


def _redis_acl_username(tenant: str, app: str) -> str:
    return f"{tenant}-{app}"


def _profile_requirements(profile: dict[str, Any]) -> dict[str, Any]:
    kr = profile.get("spec", {}).get("kernelRequirements") or {}
    db = kr.get("database") or {}
    storage = kr.get("storage") or {}
    cache = kr.get("cache") or {}
    return {
        "db_engine": db.get("engine"),
        "s3": storage.get("s3"),
        "redis": cache.get("engine") == "redis",
        "sidecars": [s.get("name") for s in profile.get("spec", {}).get("sidecars") or [] if s.get("name")],
    }


class AppPurger:
    def __init__(self, kernel_namespace: str = KERNEL_NAMESPACE) -> None:
        self._kernel_ns = kernel_namespace
        self._core = client.CoreV1Api()
        self._batch = client.BatchV1Api()
        self._custom = client.CustomObjectsApi()
        self._auth = client.AuthenticationV1Api()

    def purge(self, tenant: str, app: str, tenant_cr: dict[str, Any], profile: dict[str, Any] | None) -> list[str]:
        warnings: list[str] = []
        reqs = _profile_requirements(profile) if profile else {"db_engine": None, "s3": None, "redis": False, "sidecars": []}

        db_engine = reqs.get("db_engine")
        if db_engine == "postgresql":
            warnings.extend(self._purge_postgresql(tenant, app))
        elif db_engine == "mariadb":
            warnings.extend(self._purge_mariadb(tenant, app, tenant_cr))
        elif db_engine:
            warnings.append(f"Unsupported database engine '{db_engine}' for '{app}'; skipped DB purge.")

        if reqs.get("s3"):
            warnings.extend(self._purge_s3(tenant, app, tenant_cr))
        if reqs.get("redis"):
            warnings.extend(self._purge_redis(tenant, app))

        warnings.extend(self._purge_openbao_secrets(tenant, app, reqs.get("sidecars") or []))
        warnings.extend(self._purge_cluster_artifacts(tenant, app))
        return warnings

    def _postgres_pod(self) -> str | None:
        pods = self._core.list_namespaced_pod(
            self._kernel_ns,
            label_selector="cnpg.io/cluster=postgres",
        )
        if not pods.items:
            return None
        return pods.items[0].metadata.name

    def _exec_postgres(self, pod: str, sql: str) -> str | None:
        try:
            output = stream(
                self._core.connect_get_namespaced_pod_exec,
                pod,
                self._kernel_ns,
                command=["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
                container="postgres",
                stderr=True,
                stdout=True,
                stdin=False,
                tty=False,
            )
            return output
        except ApiException as exc:
            return str(exc)

    def _purge_postgresql(self, tenant: str, app: str) -> list[str]:
        warnings: list[str] = []
        db_name = _db_role_name(tenant, app)
        pod = self._postgres_pod()
        if not pod:
            return [f"Postgres pod not found; skipped purge for {db_name}."]

        for sql in (
            f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{db_name}';",
            f'DROP DATABASE IF EXISTS "{db_name}";',
            f'DROP ROLE IF EXISTS "{db_name}";',
        ):
            result = self._exec_postgres(pod, sql)
            if result and ("ERROR" in result or "error" in result.lower()):
                warnings.append(f"Postgres purge step failed for {db_name}: {result.strip()}")
                return warnings
        return warnings

    def _delete_job_if_exists(self, name: str) -> None:
        try:
            self._batch.delete_namespaced_job(
                name,
                self._kernel_ns,
                propagation_policy="Background",
            )
        except ApiException as exc:
            if exc.status != 404:
                raise

    def _wait_job(self, name: str, timeout: int = 300) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                job = self._batch.read_namespaced_job(name, self._kernel_ns)
            except ApiException as exc:
                if exc.status == 404:
                    return False
                raise
            for cond in job.status.conditions or []:
                if cond.type == "Complete" and cond.status == "True":
                    return True
                if cond.type == "Failed" and cond.status == "True":
                    return False
            time.sleep(3)
        return False

    def _apply_job(self, body: dict[str, Any]) -> list[str]:
        name = body["metadata"]["name"]
        self._delete_job_if_exists(name)
        self._batch.create_namespaced_job(self._kernel_ns, body)
        if not self._wait_job(name):
            return [f"Provisioning job '{name}' did not complete successfully."]
        return []

    def _job_labels(self, tenant: str, app: str) -> dict[str, str]:
        return {
            "gentianos.io/tenant": tenant,
            "gentianos.io/app": app,
            "app.kubernetes.io/managed-by": "gentian-os",
        }

    def _purge_mariadb(self, tenant: str, app: str, tenant_cr: dict[str, Any]) -> list[str]:
        db_name = _database_name(tenant_cr, app)
        db_user = _mariadb_user_name(tenant, app)
        job_name = f"mariadb-delete-{tenant}-{app}"
        body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": job_name,
                "namespace": self._kernel_ns,
                "labels": self._job_labels(tenant, app),
            },
            "spec": {
                "ttlSecondsAfterFinished": 3600,
                "template": {
                    "spec": {
                        "restartPolicy": "OnFailure",
                        "containers": [
                            {
                                "name": "delete-db",
                                "image": "mariadb:11",
                                "command": ["/bin/bash", "-c"],
                                "args": [
                                    f"""
set -euo pipefail
MARIADB="mariadb -h${{MYSQL_HOST}} -P${{MYSQL_TCP_PORT}} -u${{MYSQL_ADMIN_USER}}"
$MARIADB -e "REVOKE ALL PRIVILEGES, GRANT OPTION FROM '{db_user}'@'%';" 2>/dev/null || true
$MARIADB -e "DROP USER IF EXISTS '{db_user}'@'%';"
$MARIADB -e "DROP DATABASE IF EXISTS {db_name};"
echo "deleted database {db_name} and user {db_user}"
""".strip()
                                ],
                                "env": [
                                    {"name": "MYSQL_HOST", "valueFrom": {"secretKeyRef": {"name": "mariadb-admin", "key": "host"}}},
                                    {"name": "MYSQL_TCP_PORT", "valueFrom": {"secretKeyRef": {"name": "mariadb-admin", "key": "port"}}},
                                    {"name": "MYSQL_PWD", "valueFrom": {"secretKeyRef": {"name": "mariadb-admin", "key": "password"}}},
                                    {"name": "MYSQL_ADMIN_USER", "valueFrom": {"secretKeyRef": {"name": "mariadb-admin", "key": "username"}}},
                                ],
                            }
                        ],
                    }
                },
            },
        }
        return self._apply_job(body)

    def _purge_s3(self, tenant: str, app: str, tenant_cr: dict[str, Any]) -> list[str]:
        bucket = _s3_bucket_name(tenant_cr, app)
        job_name = f"s3-delete-{tenant}-{app}"
        body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": job_name,
                "namespace": self._kernel_ns,
                "labels": self._job_labels(tenant, app),
            },
            "spec": {
                "ttlSecondsAfterFinished": 3600,
                "template": {
                    "spec": {
                        "restartPolicy": "OnFailure",
                        "containers": [
                            {
                                "name": "delete-bucket",
                                "image": "minio/mc:RELEASE.2025-04-03T17-07-56Z",
                                "command": ["/bin/sh", "-c"],
                                "args": [
                                    f"""
set -eu
mc alias set gentian "${{MINIO_ENDPOINT}}" "${{MINIO_ACCESS_KEY}}" "${{MINIO_SECRET_KEY}}"
mc rb --force "gentian/{bucket}" 2>/dev/null || echo "bucket {bucket} already gone"
echo "bucket {bucket} removed"
""".strip()
                                ],
                                "env": [
                                    {"name": "MINIO_ENDPOINT", "valueFrom": {"secretKeyRef": {"name": "minio-admin", "key": "endpoint"}}},
                                    {"name": "MINIO_ACCESS_KEY", "valueFrom": {"secretKeyRef": {"name": "minio-admin", "key": "accessKey"}}},
                                    {"name": "MINIO_SECRET_KEY", "valueFrom": {"secretKeyRef": {"name": "minio-admin", "key": "secretKey"}}},
                                ],
                            }
                        ],
                    }
                },
            },
        }
        return self._apply_job(body)

    def _purge_redis(self, tenant: str, app: str) -> list[str]:
        username = _redis_acl_username(tenant, app)
        job_name = f"redis-acl-delete-{tenant}-{app}"
        body = {
            "apiVersion": "batch/v1",
            "kind": "Job",
            "metadata": {
                "name": job_name,
                "namespace": self._kernel_ns,
                "labels": self._job_labels(tenant, app),
            },
            "spec": {
                "ttlSecondsAfterFinished": 3600,
                "template": {
                    "spec": {
                        "restartPolicy": "OnFailure",
                        "containers": [
                            {
                                "name": "del-acl-user",
                                "image": "redis:7-alpine",
                                "command": ["/bin/sh", "-c"],
                                "args": [
                                    f"""
set -euo pipefail
redis-cli -h "$REDIS_HOST" -p "${{REDIS_PORT:-6379}}" -a "$REDIS_PASSWORD" --no-auth-warning \\
  ACL DELUSER {username} 2>/dev/null || echo "user {username} already absent"
echo done
""".strip()
                                ],
                                "env": [
                                    {"name": "REDIS_HOST", "valueFrom": {"secretKeyRef": {"name": "redis-admin", "key": "host"}}},
                                    {"name": "REDIS_PORT", "valueFrom": {"secretKeyRef": {"name": "redis-admin", "key": "port"}}},
                                    {"name": "REDIS_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "redis-admin", "key": "password"}}},
                                ],
                            }
                        ],
                    }
                },
            },
        }
        return self._apply_job(body)

    def _operator_token(self) -> str | None:
        try:
            body = client.AuthenticationV1TokenRequest(
                spec=client.V1TokenRequestSpec(expiration_seconds=600)
            )
            resp = self._auth.create_namespaced_service_account_token(
                GENTIAN_OS_SA,
                GENTIAN_SYSTEM_NAMESPACE,
                body,
            )
            return resp.status.token
        except ApiException:
            return None

    def _openbao_pod(self) -> str | None:
        for selector in (
            "app.kubernetes.io/name=openbao,app.kubernetes.io/instance=openbao",
            None,
        ):
            try:
                pods = (
                    self._core.list_namespaced_pod(OPENBAO_NAMESPACE, label_selector=selector)
                    if selector
                    else self._core.list_namespaced_pod(OPENBAO_NAMESPACE)
                )
            except ApiException:
                return None
            if pods.items:
                return pods.items[0].metadata.name
        return None

    def _purge_openbao_path(self, tenant: str, app_key: str) -> list[str]:
        token = self._operator_token()
        pod = self._openbao_pod()
        if not token or not pod:
            return [f"OpenBao purge skipped for '{app_key}' (operator token or pod unavailable)."]

        base_path = f"gentian-os/tenants/{tenant}/apps/{app_key}"
        script = f"""
set -eu
BAO_ADDR=http://127.0.0.1:8200
BAO_TOKEN='{token}'
BASE='{base_path}'
purge_kv_tree() {{
  path="$1"
  listed=$(bao kv list -mount=secret "${{path}}" 2>/dev/null || true)
  if [ -z "${{listed}}" ]; then
    bao kv metadata delete -mount=secret "${{path}}" 2>/dev/null || true
    return 0
  fi
  printf '%s\\n' "${{listed}}" | while IFS= read -r entry; do
    [ -z "${{entry}}" ] && continue
    case "${{entry}}" in
      */) purge_kv_tree "${{path}}/${{entry%/}}"
           ;;
      *) bao kv metadata delete -mount=secret "${{path}}/${{entry}}" 2>/dev/null || true
         ;;
    esac
  done
  bao kv metadata delete -mount=secret "${{path}}" 2>/dev/null || true
}}
purge_kv_tree "${{BASE}}"
echo "OpenBao path ${{BASE}} purged"
""".strip()
        try:
            stream(
                self._core.connect_get_namespaced_pod_exec,
                pod,
                OPENBAO_NAMESPACE,
                command=["sh", "-lc", script],
                stderr=True,
                stdout=True,
                stdin=False,
                tty=False,
            )
        except ApiException as exc:
            return [f"OpenBao purge for '{app_key}' failed: {exc}"]
        return []

    def _purge_openbao_secrets(self, tenant: str, app: str, sidecars: list[str]) -> list[str]:
        warnings: list[str] = []
        for key in [app, *[f"{app}-{sc}" for sc in sidecars]]:
            warnings.extend(self._purge_openbao_path(tenant, key))
        return warnings

    def _purge_cluster_artifacts(self, tenant: str, app: str) -> list[str]:
        warnings: list[str] = []
        selector = f"gentianos.io/tenant={tenant},gentianos.io/app={app},{MANAGED_BY_LABEL}"
        try:
            jobs = self._batch.list_namespaced_job(self._kernel_ns, label_selector=selector)
            for job in jobs.items:
                name = job.metadata.name
                if name:
                    self._batch.delete_namespaced_job(
                        name,
                        self._kernel_ns,
                        propagation_policy="Background",
                    )
        except ApiException as exc:
            warnings.append(f"Failed to delete kernel jobs for '{app}': {exc}")

        try:
            secrets = self._core.list_namespaced_secret(self._kernel_ns, label_selector=selector)
            for secret in secrets.items:
                name = secret.metadata.name
                if name:
                    self._core.delete_namespaced_secret(name, self._kernel_ns)
        except ApiException as exc:
            warnings.append(f"Failed to delete kernel secrets for '{app}': {exc}")

        db_cr = f"db-{tenant}-{app}"
        try:
            self._custom.delete_namespaced_custom_object(
                "postgresql.cnpg.io",
                "v1",
                self._kernel_ns,
                "databases",
                db_cr,
            )
        except ApiException as exc:
            if exc.status != 404:
                warnings.append(f"Failed to delete CNPG database '{db_cr}': {exc}")
        return warnings
