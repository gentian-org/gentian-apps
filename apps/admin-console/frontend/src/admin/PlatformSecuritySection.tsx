import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchAuthorization,
  fetchPlatformSecurityPolicy,
  updatePlatformSecurityPolicy,
  type MacWaiverEntry,
} from "@/api/admin";
import "./admin.css";
import { Trans, useTranslation } from "react-i18next";

export function PlatformSecuritySection() {
  const { t } = useTranslation();

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
    return <p className="admin-console__loading">{t("platformSecurity.loadingPlatformSecurityPolicy")}</p>;
  }
  if (policyQuery.isError || !policyQuery.data) {
    return <p className="admin-console__error">{t("platformSecurity.platformSecurityPolicyIsUnavailable")}</p>;
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
          <h2 className="admin-console__section-title">{t("platformSecurity.platformSecurity")}</h2>
          <p className="admin-console__lead">
            {t("platformSecurity.approveMacWaiversRequestedBy")}</p>
        </div>
        {draft !== null ? (
          <span className="admin-console__badge admin-console__badge--warn">{t("platformSecurity.unsavedChanges")}</span>
        ) : null}
      </header>

      <h3 className="admin-console__subsection-title">{t("platformSecurity.whoHoldsWhat")}</h3>
      <p className="admin-console__hint">
        {t("platformSecurity.readOnlyRolesAreGranted")}</p>

      {authzQuery.isLoading ? (
        <p className="admin-console__loading">{t("platformSecurity.readingTheAuthorizationGraph")}</p>
      ) : authzQuery.isError || !authz ? (
        <p className="admin-console__empty">
          <Trans i18nKey="platformSecurity.needCanAudit" components={{ code: <code /> }} />
        </p>
      ) : (
        <>
          <div className="admin-console__table-wrap">
            <table className="admin-console__table">
              <thead>
                <tr>
                  <th>{t("platformSecurity.role")}</th>
                  <th>{t("platformSecurity.heldBy")}</th>
                  <th>{t("platformSecurity.carries")}</th>
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
                        <span className="admin-console__empty">{t("platformSecurity.nobody")}</span>
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
              {t("platformSecurity.unheldRoles", { count: authz.unheld })}
            </p>
          ) : null}
        </>
      )}

      <h3 className="admin-console__subsection-title">{t("platformSecurity.catalogueWaiverRequests")}</h3>

      {requests.length === 0 ? (
        <p className="admin-console__empty">
          {t("platformSecurity.noCatalogueProfilesCurrentlyRequest")}</p>
      ) : (
        <div className="admin-console__table-wrap">
          <table className="admin-console__table">
            <thead>
              <tr>
                <th>{t("platformSecurity.profile")}</th>
                <th>{t("platformSecurity.policy")}</th>
                <th>{t("platformSecurity.scope")}</th>
                <th>{t("platformSecurity.approved")}</th>
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
                          {t(approved ? "platformSecurity.approved" : "platformSecurity.notApproved")}
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
          {saveMutation.isPending ? "Saving…" : t("platformSecurity.saveAllowlist")}
        </button>
        {draft !== null ? (
          <button
            type="button"
            className="admin-console__btn admin-console__btn--quiet"
            onClick={() => setDraft(null)}
          >
            {t("platformSecurity.discardChanges")}</button>
        ) : null}
      </div>
    </section>
  );
}
