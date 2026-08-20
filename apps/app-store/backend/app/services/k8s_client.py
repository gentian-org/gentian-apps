from __future__ import annotations

import time
from typing import Any

from kubernetes import client, config
from kubernetes.client.rest import ApiException

GROUP = "gentianos.io"
VERSION = "v1alpha1"


class K8sClient:
    def __init__(self) -> None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        self._custom = client.CustomObjectsApi()
        self._core = client.CoreV1Api()

    def get_app_catalogue(self) -> dict[str, Any]:
        return self._custom.get_cluster_custom_object(
            GROUP, VERSION, "appcatalogues", "default"
        )

    def get_app_profile(self, name: str) -> dict[str, Any]:
        return self._custom.get_cluster_custom_object(
            GROUP, VERSION, "appprofiles", name
        )

    def list_app_profiles(self) -> list[dict[str, Any]]:
        result = self._custom.list_cluster_custom_object(GROUP, VERSION, "appprofiles")
        return result.get("items", [])

    def list_app_packages(self) -> list[dict[str, Any]]:
        """AppPackages are presets that pre-select a set of addons in the UI.

        Absent CRD is not an error: a cluster that has not yet synced the
        AppPackage CRD should still render the addon window, just without presets.
        """
        try:
            result = self._custom.list_cluster_custom_object(GROUP, VERSION, "apppackages")
        except ApiException as exc:
            if exc.status == 404:
                return []
            raise
        return result.get("items", [])

    def get_composite(self, plural: str, name: str) -> dict[str, Any] | None:
        """Fetch a cluster-scoped Crossplane composite (XApp) by name."""
        try:
            return self._custom.get_cluster_custom_object(GROUP, VERSION, plural, name)
        except ApiException as exc:
            if exc.status == 404:
                return None
            raise

    def get_composed(self, api_version: str, kind: str, name: str, namespace: str | None) -> dict[str, Any] | None:
        """Fetch one resource a composition produced, by its resourceRef."""
        group, _, version = api_version.rpartition("/")
        plural = kind.lower() + "s"
        try:
            if namespace:
                return self._custom.get_namespaced_custom_object(group, version, namespace, plural, name)
            return self._custom.get_cluster_custom_object(group, version, plural, name)
        except ApiException as exc:
            if exc.status in (403, 404):
                return None
            raise

    def list_pods(self, namespace: str, label_selector: str) -> list[Any]:
        """Pods matching a label selector, or [] if they cannot be read.

        Returning [] on error is deliberate: this only ever feeds the
        explanation of why an app is not ready, so losing it must degrade the
        message, never break the listing.
        """
        try:
            return self._core.list_namespaced_pod(
                namespace, label_selector=label_selector
            ).items
        except ApiException:
            return []

    def get_resource_quota(self, namespace: str, name: str = "tenant-quota") -> dict[str, Any] | None:
        """The tenant's quota, or None if it cannot be read.

        None on error for the same reason list_pods returns []: this feeds a
        header the store can render without, so losing it must degrade the
        page, never break the catalogue.
        """
        try:
            quota = self._core.read_namespaced_resource_quota(name, namespace)
        except ApiException:
            return None
        return self._core.api_client.sanitize_for_serialization(quota)

    def get_tenant(self, name: str) -> dict[str, Any]:
        # Tenant CRs are cluster-scoped in gentian-os
        return self._custom.get_cluster_custom_object(GROUP, VERSION, "tenants", name)

    def list_tenant_profiles(self, tenant_name: str) -> list[str]:
        tenant = self.get_tenant(tenant_name)
        apps = tenant.get("spec", {}).get("apps") or []
        return [a["profile"] for a in apps if a.get("profile")]

    def add_tenant_app(self, tenant_name: str, profile: str) -> str:
        tenant = self.get_tenant(tenant_name)
        apps = list(tenant.get("spec", {}).get("apps") or [])
        if any(a.get("profile") == profile for a in apps):
            return "already_installed"
        apps.append({"profile": profile})
        self._custom.patch_cluster_custom_object(
            GROUP,
            VERSION,
            "tenants",
            tenant_name,
            {"spec": {"apps": apps}},
        )
        return "installed"

    def remove_tenant_app(self, tenant_name: str, profile: str) -> str:
        tenant = self.get_tenant(tenant_name)
        apps = list(tenant.get("spec", {}).get("apps") or [])
        next_apps = [a for a in apps if a.get("profile") != profile]
        if len(next_apps) == len(apps):
            return "not_installed"
        self._custom.patch_cluster_custom_object(
            GROUP,
            VERSION,
            "tenants",
            tenant_name,
            {"spec": {"apps": next_apps}},
        )
        return "uninstalled"

    def get_app_claim(self, namespace: str, profile: str) -> dict[str, Any] | None:
        for claim in self.list_apps_in_namespace(namespace):
            if claim.get("spec", {}).get("profileRef", {}).get("name") == profile:
                return claim
        return None

    def list_apps_in_namespace(self, namespace: str) -> list[dict[str, Any]]:
        try:
            result = self._custom.list_namespaced_custom_object(
                GROUP, VERSION, namespace, "apps"
            )
            return result.get("items", [])
        except ApiException:
            return []

    def create_app_claim(
        self,
        namespace: str,
        name: str,
        profile: str,
        tenant_namespace: str,
        domain: str,
    ) -> dict[str, Any]:
        body = {
            "apiVersion": f"{GROUP}/{VERSION}",
            "kind": "App",
            "metadata": {"name": name, "namespace": namespace},
            "spec": {
                "profileRef": {"name": profile},
                "tenantNamespace": tenant_namespace,
                "domain": domain,
            },
        }
        return self._custom.create_namespaced_custom_object(
            GROUP, VERSION, namespace, "apps", body
        )

    def delete_app_claim(self, namespace: str, name: str) -> None:
        self._custom.delete_namespaced_custom_object(
            GROUP, VERSION, namespace, "apps", name
        )

    def app_claim_exists(self, namespace: str, name: str) -> bool:
        try:
            self._custom.get_namespaced_custom_object(
                GROUP, VERSION, namespace, "apps", name
            )
            return True
        except ApiException as exc:
            if exc.status == 404:
                return False
            raise

    def wait_app_claim_gone(
        self, namespace: str, profile: str, timeout_seconds: int = 120
    ) -> bool:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            if self.get_app_claim(namespace, profile) is None:
                return True
            time.sleep(2)
        return self.get_app_claim(namespace, profile) is None
