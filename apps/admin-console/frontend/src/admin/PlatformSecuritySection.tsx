import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchAuthorization,
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
  // Who holds what on this cluster. Read under can_audit, which is the
  // security officer's and the auditor's, so a tenant administrator opening
  // this screen is refused this one query and still sees the rest.
  const authzQuery = useQuery({
    queryKey: ["admin", "platform", "authorization", "cluster"],
    queryFn: () => fetchAuthorization("cluster"),
    retry: false,
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
  const authz = authzQuery.data;

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

      <h3 className="admin-console__subsection-title">Who holds what</h3>
      <p className="admin-console__hint">
        Read-only. Roles are granted by putting somebody in a Keycloak group, and what each
        role carries is the authorization model&rsquo;s to say, not this screen&rsquo;s.
      </p>

      {authzQuery.isLoading ? (
        <p className="admin-console__loading">Reading the authorization graph&hellip;</p>
      ) : authzQuery.isError || !authz ? (
        <p className="admin-console__empty">
          The cluster&rsquo;s bindings need <code>can_audit</code>, which is the security
          officer&rsquo;s and the auditor&rsquo;s. Nothing is wrong if you hold neither.
        </p>
      ) : (
        <>
          <div className="admin-console__table-wrap">
            <table className="admin-console__table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Held by</th>
                  <th>Carries</th>
                </tr>
              </thead>
              <tbody>
                {authz.bindings.map((binding) => (
                  <tr key={binding.relation}>
                    <td>
                      <code>{binding.relation}</code>
                    </td>
                    <td>
                      {binding.groups.length === 0 ? (
                        <span className="admin-console__empty">nobody</span>
                      ) : (
                        binding.groups.map((group) => (
                          <div key={group}>
                            <code>{group}</code>
                          </div>
                        ))
                      )}
                    </td>
                    <td>
                      {binding.grants.map((grant) => (
                        <span key={grant} className="admin-console__badge">
                          {grant}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {authz.unheld > 0 ? (
            <p className="admin-console__hint">
              {authz.unheld} role{authz.unheld === 1 ? " is" : "s are"} held by nobody. For
              break-glass that is the intended state.
            </p>
          ) : null}
        </>
      )}

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
