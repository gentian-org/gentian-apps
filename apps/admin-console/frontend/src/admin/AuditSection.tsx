import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  downloadAuditExport,
  fetchAuditEvents,
  fetchChanges,
  type AuditEventCategory,
} from "@/api/admin";
import "./admin.css";

type AuditSectionProps = {
  tenant: string;
};

const CATEGORY_OPTIONS: Array<{ value: "" | AuditEventCategory; label: string }> = [
  { value: "", label: "All categories" },
  { value: "sign_in", label: "Sign-in" },
  { value: "admin_action", label: "Admin actions" },
  { value: "entitlement", label: "Entitlements" },
];

function formatAuditTime(epochMs: number) {
  if (!epochMs) {
    return "—";
  }
  return new Date(epochMs).toLocaleString();
}

function categoryLabel(category: AuditEventCategory) {
  return CATEGORY_OPTIONS.find((option) => option.value === category)?.label ?? category;
}

/**
 * What changed, who changed it, and what allowed them to.
 *
 * This needs no store: the commits are the record. It is shown first because
 * it is the part of an audit trail this platform can actually answer, and the
 * list says in its own words what it does not cover.
 */
function ChangeHistory({ tenant }: { tenant: string }) {
  const changesQuery = useQuery({
    queryKey: ["admin", "changes", tenant],
    queryFn: () => fetchChanges(tenant),
  });

  if (changesQuery.isLoading) {
    return <p className="admin-console__hint">Reading the change history…</p>;
  }
  if (changesQuery.isError) {
    return (
      <p className="admin-console__hint">
        The change history is not available:{" "}
        {changesQuery.error instanceof Error ? changesQuery.error.message : "unknown error"}
      </p>
    );
  }

  const changes = changesQuery.data?.changes ?? [];
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <h3 className="admin-console__subsection-title">Changes</h3>
      <p className="admin-console__hint">{changesQuery.data?.covers}</p>
      {changes.length === 0 ? (
        <p className="admin-console__hint">Nothing has changed in this workspace yet.</p>
      ) : (
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Who</th>
              <th>Under what authority</th>
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
                    <span className="admin-console__hint">pushed by hand — no record</span>
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
          Audit log
        </h2>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            className="admin-console__btn"
            onClick={() => auditQuery.refetch()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="admin-console__btn"
            onClick={async () => {
              try {
                setError(null);
                await downloadAuditExport("csv", filters, tenant);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Export failed");
              }
            }}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="admin-console__btn"
            onClick={async () => {
              try {
                setError(null);
                await downloadAuditExport("json", filters, tenant);
              } catch (err) {
                setError(err instanceof Error ? err.message : "Export failed");
              }
            }}
          >
            Export JSON
          </button>
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
          <label htmlFor="audit-user">User / target</label>
          <input
            id="audit-user"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            placeholder="email or username substring"
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="e.g. member.invited, LOGIN"
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-category">Category</label>
          <select
            id="audit-category"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as "" | AuditEventCategory)}
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-from">From</label>
          <input
            id="audit-from"
            type="datetime-local"
            value={fromFilter}
            onChange={(e) => setFromFilter(e.target.value)}
          />
        </div>
        <div className="admin-console__field">
          <label htmlFor="audit-to">To</label>
          <input
            id="audit-to"
            type="datetime-local"
            value={toFilter}
            onChange={(e) => setToFilter(e.target.value)}
          />
        </div>
        <button className="admin-console__btn admin-console__btn--primary" type="submit">
          Apply filters
        </button>
      </form>

      {error && <p className="admin-console__error">{error}</p>}

      {auditQuery.isLoading ? (
        <p>Loading audit events…</p>
      ) : auditQuery.isError ? (
        <p className="admin-console__error">Audit log is not available.</p>
      ) : events.length === 0 ? (
        <p style={{ fontSize: "0.875rem" }}>No audit events match the current filters.</p>
      ) : (
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Category</th>
              <th>Action</th>
              <th>Actor</th>
              <th>Target</th>
              <th>Result</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td>{formatAuditTime(event.occurredAt)}</td>
                <td>{categoryLabel(event.category)}</td>
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
