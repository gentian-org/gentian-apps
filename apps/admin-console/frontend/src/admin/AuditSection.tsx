import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  downloadAuditExport,
  fetchAuditEvents,
  fetchChanges,
  type AuditEventCategory,
} from "@/api/admin";
import "./admin.css";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

type AuditSectionProps = {
  tenant: string;
};

const CATEGORY_OPTIONS: Array<{ value: "" | AuditEventCategory; labelKey: string }> = [
  { value: "", labelKey: "categoryAll" },
  { value: "sign_in", labelKey: "categorySignIn" },
  { value: "admin_action", labelKey: "categoryAdminAction" },
  { value: "entitlement", labelKey: "categoryEntitlement" },
];

function formatAuditTime(epochMs: number) {
  if (!epochMs) {
    return "—";
  }
  return new Date(epochMs).toLocaleString();
}

// Takes t rather than holding a hook: a helper is not a component, and a
// label resolved at module scope would freeze the language at import time.
function categoryLabel(category: AuditEventCategory, t: TFunction) {
  const option = CATEGORY_OPTIONS.find((o) => o.value === category);
  return option ? t(`audit.${option.labelKey}`) : category;
}

/**
 * What changed, who changed it, and what allowed them to.
 *
 * This needs no store: the commits are the record. It is shown first because
 * it is the part of an audit trail this platform can actually answer, and the
 * list says in its own words what it does not cover.
 */
function ChangeHistory({ tenant }: { tenant: string }) {
  const { t } = useTranslation();

  const changesQuery = useQuery({
    queryKey: ["admin", "changes", tenant],
    queryFn: () => fetchChanges(tenant),
  });

  if (changesQuery.isLoading) {
    return <p className="admin-console__hint">{t("audit.readingTheChangeHistory")}</p>;
  }
  if (changesQuery.isError) {
    return (
      <p className="admin-console__hint">
        {t("audit.theChangeHistoryIsNot")}{" "}
        {changesQuery.error instanceof Error ? changesQuery.error.message : t("audit.unknownError")}
      </p>
    );
  }

  const changes = changesQuery.data?.changes ?? [];
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <h3 className="admin-console__subsection-title">{t("audit.changes")}</h3>
      <p className="admin-console__hint">{changesQuery.data?.covers}</p>
      {changes.length === 0 ? (
        <p className="admin-console__hint">{t("audit.nothingHasChangedInThis")}</p>
      ) : (
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>{t("audit.when")}</th>
              <th>{t("audit.what")}</th>
              <th>{t("audit.who")}</th>
              <th>{t("audit.underWhatAuthority")}</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((change) => (
              <tr key={change.commit}>
                <td>{change.at ? new Date(change.at).toLocaleString() : "—"}</td>
                <td>
                  {change.summary}
                  <div className="admin-console__mono" style={{ fontSize: "0.75rem" }}>
                    {change.commit.slice(0, 7)} · {change.files.length} file
                    {change.files.length === 1 ? "" : "s"}
                  </div>
                </td>
                <td>{change.author?.Name || change.principal || "—"}</td>
                <td>
                  {change.throughPlatform ? (
                    <span className="admin-console__mono" style={{ fontSize: "0.75rem" }}>
                      {change.decision}
                    </span>
                  ) : (
                    /* Not a failure of this screen: a commit with no trailer
                       was pushed by hand, and saying so is the point. */
                    <span className="admin-console__hint">{t("audit.pushedByHandNoRecord")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function AuditSection({ tenant }: AuditSectionProps) {
  const { t } = useTranslation();

  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"" | AuditEventCategory>("");
  const [fromFilter, setFromFilter] = useState("");
  const [toFilter, setToFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      user: userFilter || undefined,
      action: actionFilter || undefined,
      category: categoryFilter || undefined,
      from: fromFilter ? new Date(fromFilter).toISOString() : undefined,
      to: toFilter ? new Date(toFilter).toISOString() : undefined,
      limit: 200,
    }),
    [userFilter, actionFilter, categoryFilter, fromFilter, toFilter],
  );

  const auditQuery = useQuery({
    queryKey: ["admin", "audit-events", tenant, filters],
    queryFn: () => fetchAuditEvents(filters, tenant),
  });

  const events = auditQuery.data ?? [];

  return (
    <section>
      <div className="admin-console__toolbar">
        <h2 className="admin-console__section-title">
          {t("audit.auditLog")}</h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="admin-console__btn"
            onClick={() => auditQuery.refetch()}
          >
            {t("audit.refresh")}</button>
          <button
            type="button"
            className="admin-console__btn"
            onClick={async () => {
              try {
                setError(null);
                await downloadAuditExport("csv", filters, tenant);
              } catch (err) {
                setError(err instanceof Error ? err.message : t("audit.exportFailed"));
              }
            }}
          >
            {t("audit.exportCsv")}</button>
          <button
            type="button"
            className="admin-console__btn"
            onClick={async () => {
              try {
                setError(null);
                await downloadAuditExport("json", filters, tenant);
              } catch (err) {
                setError(err instanceof Error ? err.message : t("audit.exportFailed"));
              }
            }}
          >
            {t("audit.exportJson")}</button>
        </div>
      </div>

      <ChangeHistory tenant={tenant} />

      <form
        className="admin-console__form"
        onSubmit={(event) => {
          event.preventDefault();
          auditQuery.refetch();
        }}
      >
        <div className="admin-console__field">
          <label htmlFor="audit-user">{t("audit.userTarget")}</label>
          <input
            id="audit-user"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            placeholder={t("audit.emailOrUsernameSubstring")}
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-action">{t("audit.action")}</label>
          <input
            id="audit-action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder={t("audit.eGMemberInvitedLogin")}
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-category">{t("audit.category")}</label>
          <select
            id="audit-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as "" | AuditEventCategory)}
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {t(`audit.${option.labelKey}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-from">{t("audit.from")}</label>
          <input
            id="audit-from"
            type="datetime-local"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value)}
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-to">{t("audit.to")}</label>
          <input
            id="audit-to"
            type="datetime-local"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
          />
        </div>
        <button className="admin-console__btn admin-console__btn--primary" type="submit">
          {t("audit.applyFilters")}</button>
      </form>

      {error && <p className="admin-console__error">{error}</p>}

      {auditQuery.isLoading ? (
        <p>{t("audit.loadingAuditEvents")}</p>
      ) : auditQuery.isError ? (
        <p className="admin-console__error">{t("audit.auditLogIsNotAvailable")}</p>
      ) : events.length === 0 ? (
        <p style={{ fontSize: "0.875rem" }}>{t("audit.noAuditEventsMatchThe")}</p>
      ) : (
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>{t("audit.time")}</th>
              <th>{t("audit.category2")}</th>
              <th>{t("audit.action2")}</th>
              <th>{t("audit.actor")}</th>
              <th>{t("audit.target")}</th>
              <th>{t("audit.result")}</th>
              <th>{t("audit.ip")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatAuditTime(event.occurredAt)}</td>
                <td>{categoryLabel(event.category, t)}</td>
                <td className="admin-console__mono">{event.action}</td>
                <td>{event.actor ?? "—"}</td>
                <td>{event.target ?? "—"}</td>
                <td>{event.success ? "OK" : "Failed"}</td>
                <td className="admin-console__mono">{event.ipAddress ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
