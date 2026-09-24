import { apiFetch } from "@/api/client";

/**
 * One setting of the cluster, as the director describes it.
 *
 * The catalogue arrives with the values, so the console renders the screen
 * from one answer and holds no list of its own. A setting with no `value` is
 * unset in the claim, which is a different thing from set to nothing: the
 * schema's default applies, and the screen says so rather than showing a blank
 * box that looks like someone cleared it.
 */
export type ClusterSetting = {
  /** Dotted path within the claim's spec, e.g. "mail.serviceMode". */
  path: string;
  /** What this setting is for, written for the person changing it. */
  doc: string;
  /** The values it accepts, when it is a closed set. */
  oneOf?: string[];
  /** What the claim carries now. Absent when the claim does not set it. */
  value?: string;
  /**
   * What applies while the setting is unset, from the Cluster XRD. Absent
   * when the schema declares no default, which is itself the answer: nothing
   * is applied, and the screen must not invent a value.
   */
  default?: string;
};

export type ClusterSettingsResponse = {
  cluster: string;
  settings: ClusterSetting[];
};

/**
 * The outcome of a write, which is a commit rather than a save.
 *
 * 202 means git has the change and the cluster does not yet, and `commit` is
 * the handle to follow it. 200 means the state asked for already held and
 * nothing was committed.
 */
export type ClusterSettingsWriteResult = {
  status: string;
  commit?: string;
  /** False when the request changed nothing. */
  changed: boolean;
};

export function fetchClusterSettings() {
  return apiFetch<ClusterSettingsResponse>("/cluster/settings");
}

export async function updateClusterSettings(
  settings: Record<string, string>,
): Promise<ClusterSettingsWriteResult> {
  const body = await apiFetch<{ status: string; commit?: string }>("/cluster/settings", {
    method: "PATCH",
    body: JSON.stringify({ settings }),
  });
  return { ...body, changed: Boolean(body.commit) };
}

/**
 * One tenant, as the deployments repository has it.
 *
 * From git and not from the cluster: a tenant whose manifest is committed but
 * which the operator has not finished provisioning is still a tenant, and the
 * screen says committed rather than pretending it is absent.
 */
export type ClusterTenant = {
  name: string;
  displayName?: string;
  /** The Keycloak realm this tenant's people live in. */
  realm?: string;
  /** Profile names installed into it. */
  apps: string[];
  /** True for a tenant the director refuses to retire. */
  protected: boolean;
};

export type ClusterTenantsResponse = {
  cluster: string;
  tenants: ClusterTenant[];
};

export function fetchClusterTenants() {
  return apiFetch<ClusterTenantsResponse>("/cluster/tenants");
}

export async function createClusterTenant(
  name: string,
  displayName: string,
): Promise<ClusterSettingsWriteResult> {
  const body = await apiFetch<{ status: string; commit?: string }>("/cluster/tenants", {
    method: "POST",
    body: JSON.stringify({ name, displayName }),
  });
  return { ...body, changed: Boolean(body.commit) };
}

export async function retireClusterTenant(name: string): Promise<ClusterSettingsWriteResult> {
  const body = await apiFetch<{ status: string; commit?: string }>(
    `/cluster/tenants/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  return { ...body, changed: Boolean(body.commit) };
}
