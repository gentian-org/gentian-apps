import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  downloadAuditExport,
  fetchAuditEvents,
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

      <p style={{ fontSize: "0.875rem", color: "var(--gtn-ink-4)", marginBottom: "1rem" }}>
        Admin mutations are stored in the portal database when configured. Sign-in events are
        fetched live from Keycloak when realm events are enabled.
      </p>

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
