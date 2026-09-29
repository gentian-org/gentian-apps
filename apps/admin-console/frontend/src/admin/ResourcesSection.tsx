import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  changeResourcePlan,
  fetchResourcePlans,
  fetchResourceReport,
  fetchResourceState,
  fetchResourceUsage,
  fetchTenantResourceStates,
  type ResourcePlan,
  type ResourceState,
} from "@/api/admin";
import { UsageChart } from "@/admin/UsageChart";
import { formatQuantity, parseQuantity, quantityKind, resourceLabel } from "@/admin/resourceQuantity";
import "./admin.css";
import { useTranslation } from "react-i18next";

type ResourcesSectionProps = {
  tenant: string;
  isPlatformAdmin: boolean;
};

/** How far back the history charts and the billing report look. */
const RANGES = [
  { id: "7d", labelKey: "range7d", days: 7 },
  { id: "30d", labelKey: "range30d", days: 30 },
  { id: "90d", labelKey: "range90d", days: 90 },
  { id: "365d", labelKey: "range365d", days: 365 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

function windowFor(range: RangeId): { from: string; to: string } {
  const days = RANGES.find((r) => r.id === range)?.days ?? 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * How close to the ceiling counts as worth flagging.
 *
 * Not a warning about breaching the quota — the quota does not get breached,
 * it refuses the next pod. It is a warning that the next install or restart is
 * the one that fails, which is the moment worth catching before it arrives.
 */
const TIGHT = 0.85;

function meterClass(ratio: number | null | undefined): string {
  if (ratio == null) {
    return "resource-meter__fill";
  }
  if (ratio >= 1) {
    return "resource-meter__fill resource-meter__fill--full";
  }
  if (ratio >= TIGHT) {
    return "resource-meter__fill resource-meter__fill--tight";
  }
  return "resource-meter__fill";
}

function planLabel(plan: ResourcePlan): string {
  return plan.displayName || plan.name;
}

export function ResourcesSection({ tenant, isPlatformAdmin }: ResourcesSectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  // A platform operator manages any tenant from here; a tenant administrator
  // only ever sees their own, and the BFF refuses anything else regardless of
  // what this holds.
  const [selected, setSelected] = useState(tenant);
  const [range, setRange] = useState<RangeId>("30d");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const overviewQuery = useQuery({
    queryKey: ["admin", "resources", "tenants"],
    queryFn: () => fetchTenantResourceStates(),
    enabled: isPlatformAdmin,
  });

  const stateQuery = useQuery({
    queryKey: ["admin", "resources", "state", selected],
    queryFn: () => fetchResourceState(selected),
  });

  const plansQuery = useQuery({
    queryKey: ["admin", "resources", "plans", selected],
    queryFn: () => fetchResourcePlans(selected),
  });

  const historyWindow = useMemo(() => windowFor(range), [range]);

  const usageQuery = useQuery({
    queryKey: ["admin", "resources", "usage", selected, range],
    queryFn: () => fetchResourceUsage(historyWindow, selected),
  });

  const reportQuery = useQuery({
    queryKey: ["admin", "resources", "report", selected, range],
    queryFn: () => fetchResourceReport(historyWindow, selected),
  });

  const changeMutation = useMutation({
    mutationFn: ({ plan, force }: { plan: string; force: boolean }) =>
      changeResourcePlan(plan, selected, force),
    onSuccess: (result) => {
      setError(null);
      setPending(null);
      setSuccess(
        result.status === "unchanged"
          ? `${selected} is already on ${result.plan}.`
          : `${selected} moved to ${result.plan}. ${result.message}`,
      );
      void queryClient.invalidateQueries({ queryKey: ["admin", "resources"] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setPending(null);
      setError(err.message);
    },
  });

  const state = stateQuery.data;
  const plans = plansQuery.data ?? [];
  const samples = usageQuery.data?.samples ?? [];

  // Chart one panel per resource that actually appears in the history, in the
  // order the cluster reports them, so a tenant with no PVCs gets no empty
  // storage chart.
  const chartedResources = useMemo(() => {
    const seen = new Set<string>();
    for (const sample of samples) {
      for (const key of Object.keys(sample.used ?? {})) {
        seen.add(key);
      }
    }
    return [...seen].sort();
  }, [samples]);

  function requestChange(plan: ResourcePlan, force: boolean) {
    setError(null);
    setSuccess(null);
    setPending(plan.name);
    changeMutation.mutate({ plan: plan.name, force });
  }

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("resources.resources")}</h2>
          <p className="admin-console__lead">
            {t("resources.aWorkspaceRunsUnderA")}</p>
        </div>
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin", "resources"] })}
        >
          {t("resources.refresh")}</button>
      </header>

      {error && <p className="admin-console__error">{error}</p>}
      {success && <p className="admin-console__success">{success}</p>}

      {isPlatformAdmin && (
        <div className="admin-console__subsection">
          <h3 className="admin-console__subsection-title">{t("resources.allTenants")}</h3>
          {overviewQuery.isLoading && <p className="admin-console__loading">{t("resources.loading")}</p>}
          {overviewQuery.isError && (
            <p className="admin-console__error">{t("resources.theClusterOverviewCouldNot")}</p>
          )}
          {overviewQuery.data && (
            <div className="admin-console__table-wrap">
              <table className="admin-console__table">
                <thead>
                  <tr>
                    <th>{t("resources.tenant")}</th>
                    <th>{t("resources.plan")}</th>
                    <th>{t("resources.headroom")}</th>
                    <th>{t("resources.apps")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overviewQuery.data.map((row) => (
                    <tr key={row.tenant} className={row.tenant === selected ? "admin-console__row--editing" : undefined}>
                      <td className="admin-console__mono">{row.tenant}</td>
                      <td>
                        {row.plan || <span className="admin-console__hint">{t("resources.noPlan")}</span>}
                        {row.custom && (
                          <span className="admin-console__badge admin-console__badge--warn">{t("resources.custom")}</span>
                        )}
                        {row.drifted && (
                          <span className="admin-console__badge admin-console__badge--warn">{t("resources.drifted")}</span>
                        )}
                      </td>
                      <td>
                        <TenantHeadroom state={row} />
                      </td>
                      <td>{row.installedApps}</td>
                      <td>
                        <button
                          type="button"
                          className="admin-console__btn admin-console__btn--quiet"
                          disabled={row.tenant === selected}
                          onClick={() => {
                            setSelected(row.tenant);
                            setError(null);
                            setSuccess(null);
                          }}
                        >
                          {row.tenant === selected ? "Selected" : "Manage"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">
          {isPlatformAdmin
            ? t("resources.currentCeilingFor", { tenant: selected })
            : t("resources.currentCeiling")}
        </h3>

        {stateQuery.isLoading && <p className="admin-console__loading">{t("resources.loading2")}</p>}
        {stateQuery.isError && (
          <p className="admin-console__error">
            {t("resources.theResourcesApiCouldNot")}</p>
        )}

        {state && (
          <>
            <div className="admin-console__stats admin-console__stats--strip">
              <div className="admin-console__stat">
                <span className="admin-console__stat-value">{state.plan || "custom"}</span>
                <span className="admin-console__stat-label">{t("resources.plan2")}</span>
              </div>
              <div className="admin-console__stat">
                <span className="admin-console__stat-value">{state.installedApps}</span>
                <span className="admin-console__stat-label">{t("resources.installedApps")}</span>
              </div>
            </div>

            {state.custom && (
              <p className="admin-console__warning">
                {t("resources.thisWorkspaceSCeilingWas")}</p>
            )}
            {state.drifted && (
              <p className="admin-console__warning">
                {t("resources.ceilingDrifted", { plan: state.annotatedPlan })}
              </p>
            )}

            {!state.hasQuota ? (
              <p className="admin-console__empty">
                {t("resources.thisWorkspaceRunsWithoutA")}</p>
            ) : (
              <div className="admin-console__table-wrap">
                <table className="admin-console__table">
                  <thead>
                    <tr>
                      <th>{t("resources.resource")}</th>
                      <th>{t("resources.committed")}</th>
                      <th>{t("resources.ceiling")}</th>
                      <th>{t("resources.headroom2")}</th>
                      <th>{t("resources.inUseNow")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.quota.map((row) => {
                      const kind = quantityKind(row.resource);
                      const actual = state.actual?.[row.resource];
                      return (
                        <tr key={row.resource}>
                          <td>{resourceLabel(row.resource)}</td>
                          <td className="admin-console__mono">
                            {formatQuantity(parseQuantity(row.used), kind)}
                          </td>
                          <td className="admin-console__mono">
                            {row.hard ? formatQuantity(parseQuantity(row.hard), kind) : "—"}
                          </td>
                          <td>
                            <span className="resource-meter">
                              <span
                                className={meterClass(row.usedRatio)}
                                style={{ width: `${Math.min(100, (row.usedRatio ?? 0) * 100)}%` }}
                              />
                            </span>
                            <span className="admin-console__hint">
                              {row.usedRatio == null
                                ? t("resources.noCeiling")
                                : `${Math.round(row.usedRatio * 100)}%`}
                            </span>
                          </td>
                          <td className="admin-console__mono">
                            {actual ? formatQuantity(parseQuantity(actual), kind) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {!state.actual || Object.keys(state.actual).length === 0 ? (
              <p className="admin-console__hint">
                {t("resources.liveConsumption", {
                  source: state.actualSource || t("resources.unavailable"),
                })}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">{t("resources.plans")}</h3>
        <p className="admin-console__lead">
          {t(isPlatformAdmin ? "resources.plansLeadAdmin" : "resources.plansLeadTenant")}
        </p>

        {plansQuery.isLoading && <p className="admin-console__loading">{t("resources.loading3")}</p>}
        {plansQuery.data?.length === 0 && (
          <p className="admin-console__empty">
            {t("resources.noResourcePlansAreDefined")}</p>
        )}

        <div className="admin-console__cards">
          {plans.map((plan) => (
            <article
              key={plan.name}
              className={`admin-console__card${plan.current ? " admin-console__card--attention" : ""}`}
            >
              <div className="admin-console__card-main">
                <div className="admin-console__card-title">
                  <span>{planLabel(plan)}</span>
                  {plan.current && (
                    <span className="admin-console__badge admin-console__badge--ok">{t("resources.current")}</span>
                  )}
                  {plan.productSku && (
                    <span className="admin-console__badge">{plan.productSku}</span>
                  )}
                </div>
                {plan.description && (
                  <p className="admin-console__card-desc">{plan.description}</p>
                )}
                <p className="admin-console__card-meta">
                  {Object.entries(plan.quotas).map(([key, value]) => (
                    <code key={key}>
                      {key} {value}
                    </code>
                  ))}
                </p>
                {plan.blocked && <p className="admin-console__hint">{plan.blocked}</p>}
              </div>

              <div className="admin-console__card-aside admin-console__card-aside--top">
                {!plan.current && (
                  <button
                    type="button"
                    className="admin-console__btn admin-console__btn--primary"
                    disabled={!plan.selectable || changeMutation.isPending}
                    onClick={() => requestChange(plan, false)}
                  >
                    {t(pending === plan.name ? "resources.applying" : "resources.switchToThisPlan")}
                  </button>
                )}
                {/* Force exists only for a platform operator, and only where the
                    plan is blocked. Shrinking below current use does not fail
                    loudly — the cluster refuses the next pod create, so
                    everything runs until something restarts and then does not
                    come back. That is a decision, not a retry. */}
                {isPlatformAdmin && !plan.current && !plan.selectable && plan.blocked && (
                  <button
                    type="button"
                    className="admin-console__btn admin-console__btn--danger"
                    disabled={changeMutation.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          t("resources.shrinkConfirm", {
                            tenant: selected,
                            plan: planLabel(plan),
                            blocked: plan.blocked,
                          }),
                        )
                      ) {
                        requestChange(plan, true);
                      }
                    }}
                  >
                    {t("resources.force")}</button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="admin-console__subsection">
        <div className="admin-console__section-head">
          <h3 className="admin-console__subsection-title">{t("resources.history")}</h3>
          <div className="admin-console__toggle-group" role="group" aria-label={t("resources.timeRange")}>
            {RANGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`admin-console__btn${range === entry.id ? " admin-console__btn--primary" : " admin-console__btn--quiet"}`}
                aria-pressed={range === entry.id}
                onClick={() => setRange(entry.id)}
              >
                {t(`resources.${entry.labelKey}`)}
              </button>
            ))}
          </div>
        </div>

        {usageQuery.isLoading && <p className="admin-console__loading">{t("resources.loading4")}</p>}
        {usageQuery.isError && (
          <p className="admin-console__error">{t("resources.theUsageHistoryCouldNot")}</p>
        )}
        {usageQuery.data && samples.length === 0 && (
          <p className="admin-console__empty">
            {t("resources.noSamplesInThisWindow")}</p>
        )}

        {chartedResources.map((resource) => (
          <UsageChart key={resource} resource={resource} samples={samples} />
        ))}
      </div>

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">{t("resources.billedPlanIntervals")}</h3>
        <p className="admin-console__lead">
          {t("resources.whatThisWindowResolvesTo")}</p>

        {reportQuery.isLoading && <p className="admin-console__loading">{t("resources.loading5")}</p>}
        {reportQuery.data?.incomplete && (
          <p className="admin-console__warning">
            {t("resources.nothingIsRecordedAboutThe")}</p>
        )}
        {reportQuery.data && reportQuery.data.intervals.length === 0 ? (
          <p className="admin-console__empty">{t("resources.noPlanIntervalsInThis")}</p>
        ) : (
          reportQuery.data && (
            <div className="admin-console__table-wrap">
              <table className="admin-console__table admin-console__table--numeric">
                <thead>
                  <tr>
                    <th>{t("resources.plan3")}</th>
                    <th>{t("resources.sku")}</th>
                    <th>{t("resources.from")}</th>
                    <th>{t("resources.to")}</th>
                    <th>{t("resources.days")}</th>
                  </tr>
                </thead>
                <tbody>
                  {reportQuery.data.intervals.map((interval) => (
                    <tr key={`${interval.plan}-${interval.from}`}>
                      <td>{interval.plan}</td>
                      <td className="admin-console__mono">{interval.productSku || "—"}</td>
                      <td>{new Date(interval.from).toLocaleDateString()}</td>
                      <td>{new Date(interval.to).toLocaleDateString()}</td>
                      <td className="admin-console__mono">
                        {(interval.seconds / 86400).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </section>
  );
}

/** A compact bar per resource, for the cluster admin's one-row-per-tenant view. */
function TenantHeadroom({ state }: { state: ResourceState }) {
  const { t } = useTranslation();

  if (!state.hasQuota || state.quota.length === 0) {
    return <span className="admin-console__hint">{t("resources.noCeiling")}</span>;
  }
  return (
    <span className="resource-headroom">
      {state.quota
        .filter((row) => row.usedRatio != null)
        .map((row) => (
          <span key={row.resource} className="resource-headroom__item">
            <span className="resource-headroom__label">{resourceLabel(row.resource)}</span>
            <span className="resource-meter resource-meter--compact">
              <span
                className={meterClass(row.usedRatio)}
                style={{ width: `${Math.min(100, (row.usedRatio ?? 0) * 100)}%` }}
              />
            </span>
            <span className="resource-headroom__pct">
              {Math.round((row.usedRatio ?? 0) * 100)}%
            </span>
          </span>
        ))}
    </span>
  );
}
