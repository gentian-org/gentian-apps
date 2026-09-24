import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  createClusterTenant,
  fetchClusterTenants,
  retireClusterTenant,
} from "@/api/cluster";
import "./admin.css";

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
    return <p className="admin-console__loading">Loading tenants…</p>;
  }
  if (tenantsQuery.isError || !tenantsQuery.data) {
    return (
      <p className="admin-console__error">
        Tenants are unavailable. This needs the cluster's audit relation, and the director has
        to be reachable from this console.
      </p>
    );
  }

  const { tenants } = tenantsQuery.data;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Tenants</h2>
          <p className="admin-console__lead">
            Each tenant is a manifest in the deployments repository. Bringing one on is a
            commit; the realm, the namespaces, the database and the desktop follow when Argo CD
            syncs it.
          </p>
        </div>
      </header>

      {lastCommit ? (
        <p className="admin-console__success">
          Committed as <span className="admin-console__mono">{lastCommit.slice(0, 8)}</span>.
          Provisioning follows once Argo CD has synced it.
        </p>
      ) : null}
      {createMutation.isError ? (
        <p className="admin-console__error">
          {(createMutation.error as Error).message || "The tenant could not be created."}
        </p>
      ) : null}
      {retireMutation.isError ? (
        <p className="admin-console__error">
          {(retireMutation.error as Error).message || "The tenant could not be retired."}
        </p>
      ) : null}

      <div className="admin-console__table-wrap">
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Realm</th>
              <th>Apps</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr>
                <td colSpan={4} className="admin-console__empty">
                  No tenants yet.
                </td>
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
                      title="This tenant carries the realm every administrator signs in against, so it cannot be retired here."
                    >
                      protected
                    </span>
                  ) : confirming === tenant.name ? (
                    <span className="admin-console__actions">
                      <button
                        type="button"
                        className="admin-console__btn admin-console__btn--danger-solid"
                        disabled={retireMutation.isPending}
                        onClick={() => retireMutation.mutate(tenant.name)}
                      >
                        Retire {tenant.name}
                      </button>
                      <button
                        type="button"
                        className="admin-console__btn admin-console__btn--quiet"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="admin-console__btn admin-console__btn--danger"
                      onClick={() => setConfirming(tenant.name)}
                    >
                      Retire
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirming ? (
        <p className="admin-console__hint">
          Retiring removes <span className="admin-console__mono">{confirming}</span> from git,
          and Argo CD prunes what git no longer names. Its data is kept or removed according to
          the tenant's own deletion policy, which defaults to keeping it.
        </p>
      ) : null}

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">Bring a tenant on</h3>
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
              <span className="admin-console__label-text">Name</span>
              <input
                id="tenant-name"
                type="text"
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className={nameTouched && !nameIsValid ? "admin-console__field-error" : "admin-console__hint"}>
              Lower-case letters, digits and hyphens. This becomes the namespace, the realm, the
              database prefix and the hostname, so it cannot be changed later.
            </p>
          </div>
          <div className="admin-console__field">
            <label className="admin-console__label" htmlFor="tenant-display">
              <span className="admin-console__label-text">Display name</span>
              <input
                id="tenant-display"
                type="text"
                value={displayName}
                autoComplete="off"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <p className="admin-console__hint">
              What people call this customer. Can be changed at any time.
            </p>
          </div>
          <div className="admin-console__form-footer">
            <button
              type="submit"
              className="admin-console__btn admin-console__btn--primary"
              disabled={!nameIsValid || createMutation.isPending}
            >
              {createMutation.isPending ? "Committing…" : "Commit new tenant"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
