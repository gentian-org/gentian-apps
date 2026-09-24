import { apiFetch } from "@/api/client";
import { getAccessToken } from "@/auth/oidc";

export type AdminContext = {
  tenant: string;
  realm: string;
  isPlatformAdmin: boolean;
  isTenantAdmin: boolean;
  availableTenants: string[];
  storeConfigured: boolean;
  /**
   * Cluster kernel domain, e.g. "gtn.host". Server-provided on purpose: the
   * portal answers on portal.<kernel-domain> AND on every tenant's own host,
   * so it cannot be inferred from window.location.hostname.
   */
  kernelDomain: string;
};

export type AdminMember = {
  id: string;
  username: string;
  email?: string | null;
  inviteEmail?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  enabled: boolean;
  groups: string[];
  totpConfigured?: boolean;
  totpPending?: boolean;
};

export type AdminGroup = {
  id: string;
  name: string;
  path: string;
  memberCount: number;
  gentianOdooModules?: string[];
  gentianOdooGroupRoles?: string[];
  /** The tenant provisioned this app rather than only installing it, so adding
   *  a member ticks it by default. */
  defaultGrant?: boolean;
};

function tenantQuery(tenant?: string) {
  return tenant ? `?tenant=${encodeURIComponent(tenant)}` : "";
}

export function fetchAdminContext(tenant?: string) {
  return apiFetch<AdminContext>(`/admin/context${tenantQuery(tenant)}`);
}

export function fetchMembers(tenant?: string) {
  return apiFetch<AdminMember[]>(`/admin/members${tenantQuery(tenant)}`);
}

export function createMember(
  body: {
    email: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
  },
  tenant?: string,
) {
  return apiFetch<AdminMember>(`/admin/members${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function inviteMember(
  body: {
    email: string;
    firstName?: string;
    lastName?: string;
    inviteEmail?: string;
    groupIds?: string[];
    requireTotp?: boolean;
    settingsTemplateId?: string;
  },
  tenant?: string,
) {
  return apiFetch<AdminMember>(`/admin/members/invite${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function resetMemberPassword(id: string, tenant?: string) {
  return apiFetch<{ deliveryEmail: string }>(`/admin/members/${id}/reset-password${tenantQuery(tenant)}`, {
    method: "POST",
  });
}

export function enableMemberTotp(id: string, sendEmail = true, tenant?: string) {
  return apiFetch<AdminMember>(`/admin/members/${id}/totp/enable${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify({ sendEmail }),
  });
}

export function removeMemberTotp(id: string, tenant?: string) {
  return apiFetch<AdminMember>(`/admin/members/${id}/totp${tenantQuery(tenant)}`, {
    method: "DELETE",
  });
}

export function updateMember(
  id: string,
  body: {
    email?: string;
    firstName?: string;
    lastName?: string;
    enabled?: boolean;
    inviteEmail?: string | null;
  },
  tenant?: string,
) {
  return apiFetch<AdminMember>(`/admin/members/${id}${tenantQuery(tenant)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteMember(id: string, tenant?: string) {
  return apiFetch<void>(`/admin/members/${id}${tenantQuery(tenant)}`, {
    method: "DELETE",
  });
}

export function updateMemberGroups(id: string, groupIds: string[], tenant?: string) {
  return apiFetch<AdminMember>(`/admin/members/${id}/groups${tenantQuery(tenant)}`, {
    method: "PUT",
    body: JSON.stringify({ groupIds }),
  });
}

export function fetchGroups(tenant?: string) {
  return apiFetch<AdminGroup[]>(`/admin/groups${tenantQuery(tenant)}`);
}

export function createGroup(name: string, tenant?: string) {
  return apiFetch<AdminGroup>(`/admin/groups${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function updateGroup(
  id: string,
  name: string,
  gentianOdooModules?: string[],
  gentianOdooGroupRoles?: string[],
  tenant?: string,
) {
  return apiFetch<AdminGroup>(`/admin/groups/${id}${tenantQuery(tenant)}`, {
    method: "PATCH",
    body: JSON.stringify({ name, gentianOdooModules, gentianOdooGroupRoles }),
  });
}

export function deleteGroup(id: string, tenant?: string) {
  return apiFetch<void>(`/admin/groups/${id}${tenantQuery(tenant)}`, {
    method: "DELETE",
  });
}

export type SecurityPolicies = {
  passwordMinLength: number;
  passwordRequireDigits: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireUppercase: boolean;
  passwordRequireSpecialChars: boolean;
  passwordHistoryCount: number;
  passwordMaxAgeDays: number;
  ssoSessionIdleMinutes: number;
  ssoSessionMaxHours: number;
  rememberMe: boolean;
  bruteForceProtected: boolean;
  maxLoginFailures: number;
  lockoutDurationSeconds: number;
  requireTotpAdmins: boolean;
  requireTotpMembers: "none" | "optional" | "required";
};

export function fetchSecurityPolicies(tenant?: string) {
  return apiFetch<SecurityPolicies>(`/admin/security-policies${tenantQuery(tenant)}`);
}

export function updateSecurityPolicies(body: SecurityPolicies, tenant?: string) {
  return apiFetch<SecurityPolicies>(`/admin/security-policies${tenantQuery(tenant)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export type AdminMemberSession = {
  id: string;
  memberId: string;
  memberEmail?: string | null;
  memberUsername: string;
  clientId: string;
  clientName: string;
  ipAddress?: string | null;
  startedAt: number;
  lastAccessAt: number;
};

export function fetchSessions(tenant?: string) {
  return apiFetch<AdminMemberSession[]>(`/admin/sessions${tenantQuery(tenant)}`);
}

export function fetchMemberSessions(memberId: string, tenant?: string) {
  return apiFetch<AdminMemberSession[]>(
    `/admin/members/${memberId}/sessions${tenantQuery(tenant)}`,
  );
}

export function revokeMemberSession(memberId: string, sessionId: string, tenant?: string) {
  return apiFetch<void>(
    `/admin/members/${memberId}/sessions/${sessionId}${tenantQuery(tenant)}`,
    { method: "DELETE" },
  );
}

export function revokeAllMemberSessions(memberId: string, tenant?: string) {
  return apiFetch<void>(
    `/admin/members/${memberId}/sessions/revoke-all${tenantQuery(tenant)}`,
    { method: "POST" },
  );
}

export type AuditEventCategory = "sign_in" | "admin_action" | "entitlement";

export type AuditEvent = {
  id: string;
  occurredAt: number;
  category: AuditEventCategory;
  action: string;
  actor?: string | null;
  target?: string | null;
  tenant: string;
  ipAddress?: string | null;
  success: boolean;
  details: Record<string, string>;
};

export type AuditEventFilters = {
  user?: string;
  action?: string;
  category?: AuditEventCategory;
  from?: string;
  to?: string;
  limit?: number;
};

function auditQuery(filters: AuditEventFilters, tenant?: string) {
  const params = new URLSearchParams();
  if (tenant) {
    params.set("tenant", tenant);
  }
  if (filters.user) {
    params.set("user", filters.user);
  }
  if (filters.action) {
    params.set("action", filters.action);
  }
  if (filters.category) {
    params.set("category", filters.category);
  }
  if (filters.from) {
    params.set("from", filters.from);
  }
  if (filters.to) {
    params.set("to", filters.to);
  }
  if (filters.limit) {
    params.set("limit", String(filters.limit));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function fetchAuditEvents(filters: AuditEventFilters = {}, tenant?: string) {
  return apiFetch<AuditEvent[]>(`/admin/audit-events${auditQuery(filters, tenant)}`);
}

export async function downloadAuditExport(
  format: "json" | "csv",
  filters: AuditEventFilters = {},
  tenant?: string,
) {
  const params = new URLSearchParams(auditQuery(filters, tenant).replace(/^\?/, ""));
  params.set("format", format);
  const token = getAccessToken();
  const response = await fetch(`/api/v1/admin/audit-events/export?${params.toString()}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Audit export failed: ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `audit-export.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export type NotificationSeverity = "info" | "warning" | "critical";

export type NotificationAudience = {
  scope: "platform" | "tenant";
  tenant?: string | null;
  groups: string[];
};

export type AdminNotification = {
  id: string;
  publishedAt: number;
  title: string;
  body: string;
  severity: NotificationSeverity;
  audience: NotificationAudience;
  publisher: string;
  tenant: string;
  linkUrl?: string | null;
  linkLabel?: string | null;
  expiresAt?: number | null;
  cloudEvent: Record<string, unknown>;
};

export function fetchNotifications(tenant?: string) {
  return apiFetch<AdminNotification[]>(`/admin/notifications${tenantQuery(tenant)}`);
}

export function publishNotification(
  body: {
    title: string;
    body: string;
    severity?: NotificationSeverity;
    audience?: NotificationAudience;
    linkUrl?: string;
    linkLabel?: string;
    expiresAt?: number;
  },
  tenant?: string,
) {
  return apiFetch<AdminNotification>(`/admin/notifications${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type MacWaiverEntry = {
  profile: string;
  policy: string;
  scope: string;
};

export type MacWaiverCatalogueEntry = {
  name: string;
  displayName: string;
  macWaivers: Array<{ policy: string; scope: string }>;
};

export type PlatformSecurityPolicy = {
  allowedMacWaivers: MacWaiverEntry[];
  catalogueRequests: MacWaiverCatalogueEntry[];
};

export function fetchPlatformSecurityPolicy() {
  return apiFetch<PlatformSecurityPolicy>("/admin/platform/security-policy");
}

// Customization ladder debt report — see docs/app-customization.md §8.3 in
// gentian-os. Read live from Customization CRs; the operator computes
// reviewOverdue/upstreamStale/targetVersionDrift/rungAboveRecommended on status.
export type CustomizationRecord = {
  name: string;
  namespace: string;
  summary: string;
  targetProfile: string;
  rung: string;
  scope: string;
  owner: string;
  reviewBy: string;
  phase: string;
  reviewOverdue: boolean;
  upstreamStale: boolean;
  targetVersionDrift: boolean;
  rungAboveRecommended: boolean;
};

export type CustomizationDebtByRung = {
  L0: number;
  L1: number;
  L2: number;
  L3: number;
  L4: number;
  L5: number;
  L6: number;
};

export type CustomizationDebtReport = {
  totalRecords: number;
  carriedDeltas: number;
  byRung: CustomizationDebtByRung;
  reviewOverdue: CustomizationRecord[];
  upstreamStale: CustomizationRecord[];
  rungAboveRecommended: CustomizationRecord[];
  records: CustomizationRecord[];
};

export function fetchCustomizationDebtReport() {
  return apiFetch<CustomizationDebtReport>("/admin/platform/customization-debt");
}

export function updatePlatformSecurityPolicy(allowedMacWaivers: MacWaiverEntry[]) {
  return apiFetch<PlatformSecurityPolicy>("/admin/platform/security-policy", {
    method: "PUT",
    body: JSON.stringify({ allowedMacWaivers }),
  });
}

export type IntegrationBinding = {
  name: string;
  contract: string;
  provider: string;
  consumer: string;
  capabilities: string[];
  state: string;
};

export type ConsumeGrant = {
  contract: string;
  granted: string[];
};

export type AllowConsumer = {
  app: string;
  contract: string;
  scope: string[];
};

export type AppGrant = {
  name: string;
  app: string;
  consume: ConsumeGrant[];
  allowConsumers: AllowConsumer[];
  phase: string;
};

export type IntegrationsOverview = {
  bindings: IntegrationBinding[];
  grants: AppGrant[];
  summary: {
    bindingCount: number;
    grantCount: number;
    grantReadyCount: number;
  };
  effectiveAccess: EffectiveAccessRow[];
};

export type EffectiveAccessRow = {
  contract: string;
  consumer: string;
  provider: string;
  bindingCapabilities: string[];
  grantedCapabilities: string[];
  macAllowed: boolean;
  grantPhase: string;
  openfgaGranted: Record<string, boolean>;
};

export type PlatformAuthorizationSummary = {
  tenantCount: number;
  bindingCount: number;
  grantCount: number;
  grantReadyCount: number;
  allowedMacWaivers: number;
  catalogueMacWaiverProfiles: number;
};

export function fetchPlatformAuthorizationSummary() {
  return apiFetch<PlatformAuthorizationSummary>("/admin/platform/authorization-summary");
}

export function fetchIntegrationsOverview(tenant?: string) {
  return apiFetch<IntegrationsOverview>(`/admin/integrations${tenantQuery(tenant)}`);
}

export function updateAppGrant(
  app: string,
  body: { consume: ConsumeGrant[]; allowConsumers: AllowConsumer[] },
  tenant?: string,
) {
  return apiFetch<AppGrant>(`/admin/grants/${encodeURIComponent(app)}${tenantQuery(tenant)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export type GrantableAddon = { id: string; label: string; profile: string };

/** Addons this tenant has installed and can therefore grant to a group. */
export function fetchGrantableAddons(tenant?: string) {
  return apiFetch<GrantableAddon[]>(`/admin/grantable-addons${tenantQuery(tenant)}`);
}

// --- Backups -----------------------------------------------------------------

export type BackupAppStatus = {
  name: string;
  phase: string;
  stores: string[];
  chartVersion: string;
  quiesceStart: string | null;
  quiesceEnd: string | null;
  message: string;
};

export type Backup = {
  name: string;
  phase: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  bundleBucket: string;
  bundlePrefix: string;
  encryptionMode: string;
  platformReadable: boolean;
  quiesced: string[];
  apps: BackupAppStatus[];
  message: string;
};

/** Where one manual backup is written. Mirrors TenantExport.spec.destination. */
export type BackupTarget = {
  /**
   * policy follows the workspace's backup policy — the same place the nightly
   * schedule writes. platform is the platform's own storage. custom is an
   * endpoint given here.
   */
  mode: "policy" | "platform" | "custom";
  endpoint?: string;
  bucket?: string;
  region?: string;
  /**
   * managed reuses the credential the Credential Manager already holds for
   * this workspace. transient takes keys entered on the form, which are kept
   * for the length of the export and then removed.
   */
  credentialSource?: "managed" | "transient";
  accessKey?: string;
  secretKey?: string;
};

export type BackupCreateBody = {
  name: string;
  apps: string[];
  encryption: {
    mode: "recipient" | "passphrase";
    passphrase?: string;
    recipients?: string[];
  };
  destination?: BackupTarget;
};

export function fetchBackups(tenant?: string) {
  return apiFetch<Backup[]>(`/admin/backups${tenantQuery(tenant)}`);
}

export function fetchBackup(name: string, tenant?: string) {
  return apiFetch<Backup>(`/admin/backups/${encodeURIComponent(name)}${tenantQuery(tenant)}`);
}

export function createBackup(body: BackupCreateBody, tenant?: string) {
  return apiFetch<Backup>(`/admin/backups${tenantQuery(tenant)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteBackup(name: string, tenant?: string, opts?: { force?: boolean }) {
  const force = opts?.force ? (tenant ? "&" : "?") + "force=true" : "";
  return apiFetch<void>(
    `/admin/backups/${encodeURIComponent(name)}${tenantQuery(tenant)}${force}`,
    { method: "DELETE" },
  );
}

/** An export is finished when it can no longer change on its own. */
export function backupIsTerminal(backup: Backup): boolean {
  return backup.phase === "Ready" || backup.phase === "Failed";
}

export type BackupDestination = {
  endpoint: string;
  bucket: string;
  region: string;
};

export type BackupRetention = {
  keepLast: number;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
};

/** Who can read the bundles a policy or schedule produces. */
export type BackupScheduleEncryption = {
  /**
   * platform: the cluster's key — its holder can help you restore.
   * own: a key you hold — the platform writes bundles it cannot read, and
   * nobody can help you restore.
   */
  mode: "platform" | "own";
  recipients: string[];
};

export type BackupPolicy = {
  scope: "cluster" | "tenant";
  tenant: string;
  /** False means this scope sets nothing and inherits. */
  configured: boolean;
  destination: BackupDestination;
  schedule: string;
  suspendSchedule: boolean;
  retention: BackupRetention;
  encryption: BackupScheduleEncryption;
  allowTenantOverride: boolean;
  /** What applies after inheritance, resolved by the operator. */
  effectiveEndpoint: string;
  effectiveBucket: string;
  effectiveSchedule: string;
  /** Empty means the platform's key; a key here means only its holder can read. */
  effectiveRecipients: string[];
  /** A destination whose keys have not been supplied yet. */
  credentialRequirement: string;
  credentialSatisfied: boolean;
  message: string;
};

export type BackupPolicyBody = {
  destination: BackupDestination;
  schedule: string;
  suspendSchedule: boolean;
  retention: BackupRetention;
  encryption: BackupScheduleEncryption;
  allowTenantOverride?: boolean;
  /** The tenant name, required when sending bundles to your own storage. */
  confirm?: string;
};

export function fetchClusterBackupPolicy() {
  return apiFetch<BackupPolicy>("/admin/backup-policy/cluster");
}

export function saveClusterBackupPolicy(body: BackupPolicyBody) {
  return apiFetch<BackupPolicy>("/admin/backup-policy/cluster", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function fetchBackupPolicy(tenant?: string) {
  return apiFetch<BackupPolicy>(`/admin/backup-policy${tenantQuery(tenant)}`);
}

export function saveBackupPolicy(body: BackupPolicyBody, tenant?: string) {
  return apiFetch<BackupPolicy>(`/admin/backup-policy${tenantQuery(tenant)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function resetBackupPolicy(tenant?: string) {
  return apiFetch<void>(`/admin/backup-policy${tenantQuery(tenant)}`, {
    method: "DELETE",
  });
}

export type BackupSchedule = {
  name: string;
  tenant: string;
  schedule: string;
  suspended: boolean;
  encryption: BackupScheduleEncryption;
  retention: BackupRetention;
  lastScheduleTime: string | null;
  lastSuccessfulTime: string | null;
  nextScheduleTime: string | null;
  /** Derived from the backup settings; editing it is reverted by the operator. */
  managed: boolean;
  message: string;
};

export type BackupScheduleBody = {
  schedule: string;
  suspended: boolean;
  retention: BackupRetention;
  encryption: BackupScheduleEncryption;
};

/** A freshly generated key pair. The identity is in this response and nowhere
 * else: it is not stored and cannot be produced again. */
export type MintedKey = { identity: string; recipient: string };

/** Keep a copy of a minted key in the vault, so losing the download is not fatal.
 *
 * Written by the credential manager with the caller's own OpenBao token, into
 * the caller's own workspace subtree. It is denied to External Secrets, so the
 * key can be read by a workspace administrator and not by the cluster.
 */
/** What the vault holds for this workspace. Never the key itself: the public
 * half and metadata, read from OpenBao's metadata endpoint. */
export type BackupKeyStatus = {
  exists: boolean;
  recipient: string;
  setBy: string;
  updatedAt: string;
};

export function fetchBackupKeyStatus() {
  return apiFetch<BackupKeyStatus>("/credentials/backup-identity");
}

export function escrowBackupKey(identity: string, recipient: string) {
  return apiFetch<{ tenant: string; vaultPath: string; stored: boolean }>(
    "/credentials/backup-identity",
    { method: "PUT", body: JSON.stringify({ identity, recipient }) },
  );
}

export function mintBackupKey(tenant?: string) {
  return apiFetch<MintedKey>(`/admin/backup-keys/mint${tenantQuery(tenant)}`, {
    method: "POST",
  });
}

export function fetchBackupSchedules(tenant?: string, allTenants = false) {
  const q = tenantQuery(tenant);
  const all = allTenants ? (q ? "&" : "?") + "allTenants=true" : "";
  return apiFetch<BackupSchedule[]>(`/admin/backup-schedules${q}${all}`);
}

export function saveBackupSchedule(name: string, body: BackupScheduleBody, tenant?: string) {
  return apiFetch<BackupSchedule>(
    `/admin/backup-schedules/${encodeURIComponent(name)}${tenantQuery(tenant)}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
}

export function deleteBackupSchedule(name: string, tenant?: string) {
  return apiFetch<void>(
    `/admin/backup-schedules/${encodeURIComponent(name)}${tenantQuery(tenant)}`,
    { method: "DELETE" },
  );
}

export const emptyRetention: BackupRetention = {
  keepLast: 0,
  keepDaily: 0,
  keepWeekly: 0,
  keepMonthly: 0,
  keepYearly: 0,
};

// --- Resources ---------------------------------------------------------------

export type ResourceHeadroom = {
  resource: string;
  used: string;
  hard: string;
  /** Absent when the resource has no ceiling — not zero, which would draw an
   *  empty bar for something that is in fact unlimited. */
  usedRatio?: number | null;
};

export type ResourceState = {
  tenant: string;
  plan: string;
  annotatedPlan: string;
  /** The enforced ceiling is not the one the recorded plan describes. */
  drifted: boolean;
  /** The ceiling matches no plan in the catalogue — set by hand. */
  custom: boolean;
  quota: ResourceHeadroom[];
  hasQuota: boolean;
  actual: Record<string, string>;
  /** Where `actual` came from, or why it is missing. */
  actualSource: string;
  installedApps: number;
};

export type ResourcePlan = {
  name: string;
  displayName: string;
  description: string;
  tier: number;
  productSku: string;
  quotas: Record<string, string>;
  current: boolean;
  selectable: boolean;
  /** Why `selectable` is false, in the reader's terms. */
  blocked: string;
};

export type ResourcePlanChange = {
  status: string;
  tenant: string;
  plan: string;
  previousPlan: string;
  message: string;
};

export type ResourceSample = {
  observedAt: string;
  plan: string;
  productSku: string;
  hard: Record<string, string>;
  used: Record<string, string>;
  actual?: Record<string, string> | null;
};

export type ResourceUsage = {
  tenant: string;
  samples: ResourceSample[];
};

export type ResourcePlanInterval = {
  plan: string;
  productSku: string;
  from: string;
  to: string;
  seconds: number;
  partial: boolean;
};

export type ResourceReport = {
  tenant: string;
  from: string;
  to: string;
  intervals: ResourcePlanInterval[];
  incomplete: boolean;
};

export function fetchResourceState(tenant?: string) {
  return apiFetch<ResourceState>(`/admin/resources${tenantQuery(tenant)}`);
}

export function fetchResourcePlans(tenant?: string) {
  return apiFetch<ResourcePlan[]>(`/admin/resources/plans${tenantQuery(tenant)}`);
}

export function changeResourcePlan(plan: string, tenant?: string, force = false) {
  return apiFetch<ResourcePlanChange>(`/admin/resources${tenantQuery(tenant)}`, {
    method: "PUT",
    body: JSON.stringify({ plan, force }),
  });
}

export function fetchResourceUsage(
  params: { from?: string; to?: string; stepSeconds?: number } = {},
  tenant?: string,
) {
  const search = new URLSearchParams();
  if (tenant) search.set("tenant", tenant);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  if (params.stepSeconds) search.set("stepSeconds", String(params.stepSeconds));
  const query = search.toString();
  return apiFetch<ResourceUsage>(`/admin/resources/usage${query ? `?${query}` : ""}`);
}

export function fetchResourceReport(
  params: { from?: string; to?: string } = {},
  tenant?: string,
) {
  const search = new URLSearchParams();
  if (tenant) search.set("tenant", tenant);
  if (params.from) search.set("from", params.from);
  if (params.to) search.set("to", params.to);
  const query = search.toString();
  return apiFetch<ResourceReport>(`/admin/resources/report${query ? `?${query}` : ""}`);
}

/** Every tenant's ceiling and consumption — platform administrators only. */
export function fetchTenantResourceStates() {
  return apiFetch<ResourceState[]>("/admin/resources/tenants");
}
