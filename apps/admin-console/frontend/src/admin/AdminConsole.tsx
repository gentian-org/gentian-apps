import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchAdminContext } from "@/api/admin";
import { AuditSection } from "@/admin/AuditSection";
import { BackupPolicySection } from "@/admin/BackupPolicySection";
import { BackupSchedulesSection } from "@/admin/BackupSchedulesSection";
import { BackupSection } from "@/admin/BackupSection";
import { CredentialsSection } from "@/admin/CredentialsSection";
import { CustomizationDebtSection } from "@/admin/CustomizationDebtSection";
import { ClusterSettingsSection } from "@/admin/ClusterSettingsSection";
import { IdentitySection } from "@/admin/IdentitySection";
import { IntegrationsSection } from "@/admin/IntegrationsSection";
import { NotificationsSection } from "@/admin/NotificationsSection";
import { ResourcesSection } from "@/admin/ResourcesSection";
import { PlatformSecuritySection } from "@/admin/PlatformSecuritySection";
import { SecurityPoliciesSection } from "@/admin/SecurityPoliciesSection";
import { TenantsSection } from "@/admin/TenantsSection";
import "./admin.css";

type AdminTab =
  | "tenants"
  | "people"
  | "resources"
  | "backup"
  | "security"
  | "integrations"
  | "credentials"
  | "notifications"
  | "audit"
  | "settings"
  | "platform"
  | "customization";

/**
 * The tab strip, in display order. Kept as data so a new section is one entry
 * rather than another copy of the same button — the copies are how Backup and
 * Credentials ended up looking unlike the rest of the console.
 *
 * Ordered by what someone came here to do, not by the systems underneath.
 * People first because it is the most common errand, then what the tenant runs
 * and consumes, then what protects it, then the record, then the cluster's own
 * configuration for whoever administers the platform.
 *
 * Four tabs are gone: Members, Groups, Invitations and Sessions. They needed a
 * Keycloak administrator credential this console must not hold, and Keycloak's
 * own console already does that job properly. Templates went with them — it
 * copied one member's shell preferences onto another, which is a member screen
 * wearing a different name.
 */
const TABS: { id: AdminTab; label: string; platformOnly?: boolean }[] = [
  // First, and platform-only, because bringing a customer on is what an MSP
  // employee opens this console to do. A tenant administrator sees their own
  // tenant's screens and has no business listing the others.
  { id: "tenants", label: "Tenants", platformOnly: true },
  { id: "people", label: "People" },
  { id: "resources", label: "Resources" },
  { id: "backup", label: "Backup" },
  { id: "security", label: "Security" },
  { id: "integrations", label: "Integrations" },
  { id: "credentials", label: "Credentials" },
  { id: "notifications", label: "Notifications" },
  { id: "audit", label: "Audit" },
  { id: "settings", label: "Cluster settings", platformOnly: true },
  { id: "platform", label: "Platform", platformOnly: true },
  { id: "customization", label: "Customization", platformOnly: true },
];

type AdminConsoleProps = {
  /** Render inside a desktop shell window instead of full-viewport overlay. */
  embedded?: boolean;
};

export function AdminConsole({ embedded = false }: AdminConsoleProps) {
  const [tab, setTab] = useState<AdminTab>("people");
  const contextQuery = useQuery({
    queryKey: ["admin", "context"],
    queryFn: () => fetchAdminContext(),
  });
  // No tenant literal as a fallback. Hooks must be declared before the early
  // returns below, so this runs before the loading and error guards -- but the
  // groups query is gated on the context having loaded, and every consumer of
  // `tenant` sits after those guards, so the empty string is never used. It used
  // to read `?? "demo"`, which would have queried a real, unrelated tenant the
  // moment someone reordered any of that.
  const tenant = contextQuery.data?.tenant ?? "";

  if (contextQuery.isLoading) {
    return (
      <div className={`admin-console${embedded ? " admin-console--embedded" : ""}`}>
        <div className="admin-console__frame">
          <div className="admin-console__body">
            <p className="admin-console__loading">Loading admin console…</p>
          </div>
        </div>
      </div>
    );
  }

  if (contextQuery.isError || !contextQuery.data) {
    return (
      <div className={`admin-console${embedded ? " admin-console--embedded" : ""}`}>
        <div className="admin-console__frame">
          <div className="admin-console__body admin-console__error">
            Admin Console is not available for this account.
          </div>
        </div>
      </div>
    );
  }

  const { realm, isPlatformAdmin } = contextQuery.data;

  return (
    <div className={`admin-console${embedded ? " admin-console--embedded" : ""}`}>
      <div className="admin-console__frame">
        <header className="admin-console__header">
          <div className="admin-console__identity">
            tenant {tenant}
            {isPlatformAdmin ? " · platform scope" : ""}
          </div>
          <div className="admin-console__identity admin-console__identity--muted">
            realm/{realm}
          </div>
        </header>

        <nav className="admin-console__tabs" aria-label="Admin sections">
          {TABS.filter((entry) => !entry.platformOnly || isPlatformAdmin).map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? "page" : undefined}
              className={`admin-console__tab${
                tab === entry.id ? " admin-console__tab--active" : ""
              }`}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="admin-console__body">
          {tab === "tenants" ? (
            <TenantsSection />
          ) : tab === "people" ? (
            <IdentitySection realm={realm} kernelDomain={contextQuery.data.kernelDomain} />
          ) : tab === "security" ? (
            <SecurityPoliciesSection tenant={tenant} />
          ) : tab === "integrations" ? (
            <IntegrationsSection tenant={tenant} />
          ) : tab === "resources" ? (
            <ResourcesSection tenant={tenant} isPlatformAdmin={isPlatformAdmin} />
          ) : tab === "settings" ? (
            <ClusterSettingsSection />
          ) : tab === "platform" ? (
            <PlatformSecuritySection />
          ) : tab === "customization" ? (
            <CustomizationDebtSection />
          ) : tab === "credentials" ? (
            <CredentialsSection />
          ) : tab === "notifications" ? (
            <NotificationsSection tenant={tenant} isPlatformAdmin={isPlatformAdmin} />
          ) : tab === "backup" ? (
            <>
              <BackupSchedulesSection tenant={tenant} isPlatformAdmin={isPlatformAdmin} />
              <BackupPolicySection tenant={tenant} isPlatformAdmin={isPlatformAdmin} />
              <BackupSection tenant={tenant} />
            </>
          ) : (
            <AuditSection tenant={tenant} />
          )}
        </div>
      </div>
    </div>
  );
}
