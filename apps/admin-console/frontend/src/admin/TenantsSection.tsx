import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createClusterTenant,
  fetchClusterTenants,
  retireClusterTenant,
} from "@/api/cluster";
import "./admin.css";
import { Trans, useTranslation } from "react-i18next";

/**
 * The customers this cluster carries.
 *
 * This is the errand the console exists for. An MSP employee takes a customer
 * on, and what that means here is one commit to the deployments repository:
 * Argo CD syncs it, the operator provisions the realm, the namespaces, the
 * database and the desktop, and the tenant exists. Nothing on this screen
 * touches the cluster.
 *
 * A name is asked for once and cannot be changed, because it becomes a
 * namespace, a Keycloak realm, a database prefix and a hostname, and none of
 * those can be renamed afterwards without moving data. The screen says so
 * before the field rather than after the refusal.
 */
export function TenantsSection() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const tenantsQuery = useQuery({
    queryKey: ["cluster", "tenants"],
    queryFn: () => fetchClusterTenants(),
  });
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  // Retiring is not undoable from here, so it asks once, naming the tenant.
  const [confirming, setConfirming] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["cluster", "tenants"] });

  const createMutation = useMutation({
    mutationFn: () => createClusterTenant(name.trim(), displayName.trim()),
    onSuccess: (result) => {
      setName("");
      setDisplayName("");
      setLastCommit(result.commit ?? null);
      void invalidate();
    },
  });
  const retireMutation = useMutation({
    mutationFn: (tenant: string) => retireClusterTenant(tenant),
    onSuccess: (result) => {
      setConfirming(null);
      setLastCommit(result.commit ?? null);
      void invalidate();
    },
  });

  // The same rule the director enforces, checked here so the field can say
  // what is wrong while it is being typed rather than after a round trip.
  const nameIsValid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name.trim());
  const nameTouched = name.length > 0;

  if (tenantsQuery.isLoading) {
    return <p className="admin-console__loading">{t("tenants.loadingTenants")}</p>;
  }
  if (tenantsQuery.isError || !tenantsQuery.data) {
    return (
      <p className="admin-console__error">
        {t("tenants.tenantsAreUnavailableThisNeeds")}</p>
    );
  }

  const { tenants } = tenantsQuery.data;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("tenants.tenants")}</h2>
          <p className="admin-console__lead">
            {t("tenants.eachTenantIsAManifest")}</p>
        </div>
      </header>

      {lastCommit ? (
        <p className="admin-console__success">
          <Trans
            i18nKey="tenants.committedAs"
            values={{ commit: lastCommit.slice(0, 8) }}
            components={{ mono: <span className="admin-console__mono" /> }}
          />
        </p>
      ) : null}
      {createMutation.isError ? (
        <p className="admin-console__error">
          {(createMutation.error as Error).message || t("tenants.couldNotCreate")}
        </p>
      ) : null}
      {retireMutation.isError ? (
        <p className="admin-console__error">
          {(retireMutation.error as Error).message || t("tenants.couldNotRetire")}
        </p>
      ) : null}

      <div className="admin-console__table-wrap">
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>{t("tenants.tenant")}</th>
              <th>{t("tenants.realm")}</th>
              <th>{t("tenants.apps")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr>
                <td colSpan={4} className="admin-console__empty">
                  {t("tenants.noTenantsYet")}</td>
              </tr>
            ) : null}
            {tenants.map((tenant) => (
              <tr key={tenant.name}>
                <td>
                  <span className="admin-console__mono">{tenant.name}</span>
                  {tenant.displayName && tenant.displayName !== tenant.name ? (
                    <div className="admin-console__card-meta">{tenant.displayName}</div>
                  ) : null}
                </td>
                <td className="admin-console__mono">{tenant.realm ?? "—"}</td>
                <td>{tenant.apps.length === 0 ? "—" : tenant.apps.join(", ")}</td>
                <td>
                  {tenant.protected ? (
                    <span
                      className="admin-console__badge admin-console__badge--info"
                      title={t("tenants.thisTenantCarriesTheRealm")}
                    >
                      {t("tenants.protected")}</span>
                  ) : confirming === tenant.name ? (
                    <span className="admin-console__actions">
                      <button
                        type="button"
                        className="admin-console__btn admin-console__btn--danger-solid"
                        disabled={retireMutation.isPending}
                        onClick={() => retireMutation.mutate(tenant.name)}
                      >
                        {t("tenants.retire")}{tenant.name}
                      </button>
                      <button
                        type="button"
                        className="admin-console__btn admin-console__btn--quiet"
                        onClick={() => setConfirming(null)}
                      >
                        {t("tenants.cancel")}</button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="admin-console__btn admin-console__btn--danger"
                      onClick={() => setConfirming(tenant.name)}
                    >
                      {t("tenants.retire2")}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming ? (
        <p className="admin-console__hint">
          <Trans
            i18nKey="tenants.retiringRemoves"
            values={{ tenant: confirming }}
            components={{ mono: <span className="admin-console__mono" /> }}
          />
        </p>
      ) : null}

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">{t("tenants.bringATenantOn")}</h3>
        <form
          className="admin-console__form admin-console__form--plain"
          onSubmit={(event) => {
            event.preventDefault();
            setLastCommit(null);
            createMutation.mutate();
          }}
        >
          <div className="admin-console__field">
            <label className="admin-console__label" htmlFor="tenant-name">
              <span className="admin-console__label-text">{t("tenants.name")}</span>
              <input
                id="tenant-name"
                type="text"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className={nameTouched && !nameIsValid ? "admin-console__field-error" : "admin-console__hint"}>
              {t("tenants.lowerCaseLettersDigitsAnd")}</p>
          </div>
          <div className="admin-console__field">
            <label className="admin-console__label" htmlFor="tenant-display">
              <span className="admin-console__label-text">{t("tenants.displayName")}</span>
              <input
                id="tenant-display"
                type="text"
                value={displayName}
                autoComplete="off"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <p className="admin-console__hint">
              {t("tenants.whatPeopleCallThisCustomer")}</p>
          </div>
          <div className="admin-console__form-footer">
            <button
              type="submit"
              className="admin-console__btn admin-console__btn--primary"
              disabled={!nameIsValid || createMutation.isPending}
            >
              {createMutation.isPending ? "Committing…" : t("tenants.commitNewTenant")}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
