import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchIntegrationsOverview,
  updateAppGrant,
  type AppGrant,
  type ConsumeGrant,
} from "@/api/admin";
import "./admin.css";
import { useTranslation } from "react-i18next";

type IntegrationsSectionProps = {
  tenant: string;
};

function formatOpenfga(cap: string, granted: Record<string, boolean>): string {
  if (Object.keys(granted).length === 0) {
    return "—";
  }
  const value = granted[cap];
  if (value === undefined) {
    return "—";
  }
  return value ? "yes" : "no";
}

export function IntegrationsSection({ tenant }: IntegrationsSectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const overviewQuery = useQuery({
    queryKey: ["admin", "integrations", tenant],
    queryFn: () => fetchIntegrationsOverview(tenant),
  });
  const [editing, setEditing] = useState<AppGrant | null>(null);

  const saveMutation = useMutation({
    mutationFn: (grant: AppGrant) =>
      updateAppGrant(
        grant.app,
        { consume: grant.consume, allowConsumers: grant.allowConsumers },
        tenant,
      ),
    onSuccess: () => {
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "integrations", tenant] });
    },
  });

  if (overviewQuery.isLoading) {
    return <p>{t("integrations.loadingIntegrations")}</p>;
  }
  if (overviewQuery.isError || !overviewQuery.data) {
    return <p className="admin-console__error">{t("integrations.integrationsOverviewIsUnavailable")}</p>;
  }

  const { bindings, grants, summary, effectiveAccess } = overviewQuery.data;

  return (
    <section>
      <div className="admin-console__toolbar">
        <h2 className="admin-console__section-title">
          {t("integrations.integrationsGrants")}</h2>
      </div>
      <p className="admin-console__hint" style={{ marginBottom: "1rem" }}>
        {t("integrations.activeIntegrationbindingsAreOperatorWired")}</p>

      <p className="admin-console__mono" style={{ fontSize: "0.8125rem", color: "var(--gtn-ink-4)", marginBottom: "1.5rem" }}>
        {summary.bindingCount} binding{summary.bindingCount === 1 ? "" : "s"} ·{" "}
        {summary.grantCount} grant{summary.grantCount === 1 ? "" : "s"} ·{" "}
        {summary.grantReadyCount} OpenFGA-synced
      </p>

      <h3 className="admin-console__subtitle">{t("integrations.effectiveAccess")}</h3>
      {effectiveAccess.length === 0 ? (
        <p style={{ fontSize: "0.875rem", color: "var(--gtn-ink-4)", marginBottom: "1.5rem" }}>
          {t("integrations.noIntegrationBindingsToPreview")}</p>
      ) : (
        <table className="admin-console__table" style={{ marginBottom: "2rem" }}>
          <thead>
            <tr>
              <th>{t("integrations.contract")}</th>
              <th>{t("integrations.consumerProvider")}</th>
              <th>{t("integrations.bound")}</th>
              <th>{t("integrations.granted")}</th>
              <th>{t("integrations.macEgress")}</th>
              <th>{t("integrations.grantPhase")}</th>
              <th>{t("integrations.openfga")}</th>
            </tr>
          </thead>
          <tbody>
            {effectiveAccess.map((row) => (
              <tr key={`${row.consumer}-${row.contract}`}>
                <td><code>{row.contract}</code></td>
                <td>
                  {row.consumer} → {row.provider}
                </td>
                <td>{row.bindingCapabilities.join(", ") || "—"}</td>
                <td>{row.grantedCapabilities.join(", ") || "—"}</td>
                <td>{row.macAllowed ? "allowed" : "denied"}</td>
                <td>{row.grantPhase || "—"}</td>
                <td>
                  {row.grantedCapabilities.length === 0
                    ? "—"
                    : row.grantedCapabilities
                        .map((cap) => `${cap}: ${formatOpenfga(cap, row.openfgaGranted)}`)
                        .join("; ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="admin-console__subtitle">{t("integrations.bindings")}</h3>
      {bindings.length === 0 ? (
        <p style={{ fontSize: "0.875rem", color: "var(--gtn-ink-4)", marginBottom: "1.5rem" }}>
          {t("integrations.noActiveIntegrationBindings")}</p>
      ) : (
        <table className="admin-console__table" style={{ marginBottom: "2rem" }}>
          <thead>
            <tr>
              <th>{t("integrations.contract2")}</th>
              <th>{t("integrations.consumer")}</th>
              <th>{t("integrations.provider")}</th>
              <th>{t("integrations.capabilities")}</th>
              <th>{t("integrations.state")}</th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((b) => (
              <tr key={b.name}>
                <td><code>{b.contract}</code></td>
                <td>{b.consumer}</td>
                <td>{b.provider}</td>
                <td>{b.capabilities.join(", ") || "—"}</td>
                <td>{b.state || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 className="admin-console__subtitle">{t("integrations.appGrants")}</h3>
      {grants.length === 0 ? (
        <p style={{ fontSize: "0.875rem", color: "var(--gtn-ink-4)" }}>
          {t("integrations.noAppgrantObjectsYetCreated")}</p>
      ) : (
        <table className="admin-console__table" style={{ maxWidth: "36rem", marginBottom: "2rem" }}>
          <thead>
            <tr>
              <th>{t("integrations.app")}</th>
              <th>{t("integrations.phase")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {grants.map((grant) => (
              <tr key={grant.name}>
                <td style={{ fontWeight: 600 }}>{grant.app}</td>
                <td>{grant.phase || "Pending"}</td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="admin-console__btn"
                    onClick={() => setEditing(grant)}
                  >
                    {t("integrations.editGrant")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing ? (
        <div className="admin-console__edit-panel" style={{ maxWidth: "36rem", marginTop: "1rem" }}>
          <div className="admin-console__edit-panel-header">
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>
                {t("integrations.editGrant2")}</div>
              <div className="admin-console__mono" style={{ fontSize: "0.8125rem", color: "var(--gtn-ink-4)" }}>
                {editing.app}
              </div>
            </div>
            <button type="button" className="admin-console__btn" onClick={() => setEditing(null)}>
              {t("integrations.close")}</button>
          </div>

          <div className="admin-console__edit-panel-body" style={{ padding: "1rem" }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveMutation.mutate(editing);
              }}
            >
              {editing.consume.map((entry, index) => (
                <div key={entry.contract} className="admin-console__field" style={{ marginBottom: "1rem" }}>
                  <label htmlFor={`grant-${entry.contract}`}>
                    {entry.contract} {t("integrations.capabilitiesCommaSeparated")}</label>
                  <input
                    id={`grant-${entry.contract}`}
                    value={entry.granted.join(", ")}
                    onChange={(event) => {
                      const granted = event.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const consume = editing.consume.map((c, i) =>
                        i === index ? { ...c, granted } : c,
                      ) satisfies ConsumeGrant[];
                      setEditing({ ...editing, consume });
                    }}
                  />
                </div>
              ))}
              <div className="admin-console__form-footer">
                <button
                  type="submit"
                  className="admin-console__btn admin-console__btn--primary"
                  style={{ marginRight: "0.5rem" }}
                  disabled={saveMutation.isPending}
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button type="button" className="admin-console__btn" onClick={() => setEditing(null)}>
                  {t("integrations.cancel")}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
