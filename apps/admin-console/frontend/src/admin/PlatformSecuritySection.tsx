import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchPlatformAuthorizationSummary,
  fetchPlatformSecurityPolicy,
  updatePlatformSecurityPolicy,
  type MacWaiverEntry,
} from "@/api/admin";
import "./admin.css";

export function PlatformSecuritySection() {
  const queryClient = useQueryClient();
  const policyQuery = useQuery({
    queryKey: ["admin", "platform", "security-policy"],
    queryFn: () => fetchPlatformSecurityPolicy(),
  });
  const summaryQuery = useQuery({
    queryKey: ["admin", "platform", "authorization-summary"],
    queryFn: () => fetchPlatformAuthorizationSummary(),
  });
  const [draft, setDraft] = useState<MacWaiverEntry[] | null>(null);

  const saveMutation = useMutation({
    mutationFn: (allowed: MacWaiverEntry[]) => updatePlatformSecurityPolicy(allowed),
    onSuccess: () => {
      setDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "platform", "security-policy"] });
    },
  });

  if (policyQuery.isLoading) {
    return <p className="admin-console__loading">Loading platform security policy…</p>;
  }
  if (policyQuery.isError || !policyQuery.data) {
    return <p className="admin-console__error">Platform security policy is unavailable.</p>;
  }

  const allowed = draft ?? policyQuery.data.allowedMacWaivers;
  const requests = policyQuery.data.catalogueRequests;
  const summary = summaryQuery.data;

  const toggleApproval = (profile: string, policy: string, scope: string) => {
    const key = `${profile}/${policy}/${scope}`;
    const exists = allowed.some(
      (w) => w.profile === profile && w.policy === policy && w.scope === scope,
    );
    if (exists) {
      setDraft(allowed.filter((w) => `${w.profile}/${w.policy}/${w.scope}` !== key));
      return;
    }
    setDraft([...allowed, { profile, policy, scope }]);
  };

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Platform security</h2>
          <p className="admin-console__lead">
            Approve MAC waivers requested by catalogue AppProfiles. Workloads receive waiver pod
            labels only when both the profile declares a request and the cluster allows it.
          </p>
        </div>
        {draft !== null ? (
          <span className="admin-console__badge admin-console__badge--warn">unsaved changes</span>
        ) : null}
      </header>

      {summary ? (
        <div className="admin-console__stats">
          <div className="admin-console__stat">
            <div className="admin-console__stat-value">{summary.tenantCount}</div>
            <div className="admin-console__stat-label">
              Tenant{summary.tenantCount === 1 ? "" : "s"}
            </div>
          </div>
          <div className="admin-console__stat">
            <div className="admin-console__stat-value">{summary.bindingCount}</div>
            <div className="admin-console__stat-label">
              Integration binding{summary.bindingCount === 1 ? "" : "s"}
            </div>
          </div>
          <div className="admin-console__stat">
            <div className="admin-console__stat-value">
              {summary.grantReadyCount}/{summary.grantCount}
            </div>
            <div className="admin-console__stat-label">AppGrants OpenFGA-synced</div>
          </div>
          <div
            className={`admin-console__stat${
              summary.allowedMacWaivers > 0 ? " admin-console__stat--alert" : ""
            }`}
          >
            <div className="admin-console__stat-value">{summary.allowedMacWaivers}</div>
            <div className="admin-console__stat-label">Approved MAC waivers</div>
          </div>
          <div className="admin-console__stat">
            <div className="admin-console__stat-value">{summary.catalogueMacWaiverProfiles}</div>
            <div className="admin-console__stat-label">Profiles requesting waivers</div>
          </div>
        </div>
      ) : null}

      <h3 className="admin-console__subsection-title">Catalogue waiver requests</h3>

      {requests.length === 0 ? (
        <p className="admin-console__empty">
          No catalogue profiles currently request MAC waivers.
        </p>
      ) : (
        <div className="admin-console__table-wrap">
          <table className="admin-console__table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Policy</th>
                <th>Scope</th>
                <th>Approved</th>
              </tr>
            </thead>
            <tbody>
              {requests.flatMap((entry) =>
                entry.macWaivers.map((w) => {
                  const approved = allowed.some(
                    (a) =>
                      a.profile === entry.name &&
                      a.policy === w.policy &&
                      a.scope === w.scope,
                  );
                  return (
                    <tr key={`${entry.name}-${w.policy}-${w.scope}`}>
                      <td>{entry.displayName || entry.name}</td>
                      <td><code>{w.policy}</code></td>
                      <td><code>{w.scope}</code></td>
                      <td>
                        <button
                          type="button"
                          className={`admin-console__toggle${
                            approved ? " admin-console__toggle--on" : ""
                          }`}
                          aria-pressed={approved}
                          onClick={() => toggleApproval(entry.name, w.policy, w.scope)}
                        >
                          <span className="admin-console__toggle-icon">
                            {approved ? "☑" : "☐"}
                          </span>
                          {approved ? "Approved" : "Not approved"}
                        </button>
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}

      {saveMutation.isError ? (
        <p className="admin-console__error" role="status">
          {(saveMutation.error as Error).message}
        </p>
      ) : null}

      <div className="admin-console__actions">
        <button
          type="button"
          className="admin-console__btn admin-console__btn--primary"
          disabled={draft === null || saveMutation.isPending}
          onClick={() => saveMutation.mutate(allowed)}
        >
          {saveMutation.isPending ? "Saving…" : "Save allowlist"}
        </button>
        {draft !== null ? (
          <button
            type="button"
            className="admin-console__btn admin-console__btn--quiet"
            onClick={() => setDraft(null)}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </section>
  );
}
