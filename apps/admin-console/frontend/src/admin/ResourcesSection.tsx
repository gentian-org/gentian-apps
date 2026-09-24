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

type ResourcesSectionProps = {
  tenant: string;
  isPlatformAdmin: boolean;
};

/** How far back the history charts and the billing report look. */
const RANGES = [
  { id: "7d", label: "7 days", days: 7 },
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "365d", label: "12 months", days: 365 },
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
        result.status === "no_change"
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
          <h2 className="admin-console__section-title">Resources</h2>
          <p className="admin-console__lead">
            A workspace runs under a ceiling — how much CPU, memory and storage its apps may
            claim between them. Changing plan commits the new ceiling to the deployments
            repository, the same path an app install takes, so what is running and what is
            recorded never disagree.
          </p>
        </div>
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["admin", "resources"] })}
        >
          Refresh
        </button>
      </header>

      {error && <p className="admin-console__error">{error}</p>}
      {success && <p className="admin-console__success">{success}</p>}

      {isPlatformAdmin && (
        <div className="admin-console__subsection">
          <h3 className="admin-console__subsection-title">All tenants</h3>
          {overviewQuery.isLoading && <p className="admin-console__loading">Loading…</p>}
          {overviewQuery.isError && (
            <p className="admin-console__error">The cluster overview could not be loaded.</p>
          )}
          {overviewQuery.data && (
            <div className="admin-console__table-wrap">
              <table className="admin-console__table">
                <thead>
                  <tr>
                    <th>Tenant</th>
                    <th>Plan</th>
                    <th>Headroom</th>
                    <th>Apps</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {overviewQuery.data.map((row) => (
                    <tr key={row.tenant} className={row.tenant === selected ? "admin-console__row--editing" : undefined}>
                      <td className="admin-console__mono">{row.tenant}</td>
                      <td>
                        {row.plan || <span className="admin-console__hint">no plan</span>}
                        {row.custom && (
                          <span className="admin-console__badge admin-console__badge--warn">custom</span>
                        )}
                        {row.drifted && (
                          <span className="admin-console__badge admin-console__badge--warn">drifted</span>
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
          {isPlatformAdmin ? `Current ceiling — ${selected}` : "Current ceiling"}
        </h3>

        {stateQuery.isLoading && <p className="admin-console__loading">Loading…</p>}
        {stateQuery.isError && (
          <p className="admin-console__error">
            The resources API could not be reached. Plans and usage are unavailable until it is.
          </p>
        )}

        {state && (
          <>
            <div className="admin-console__stats admin-console__stats--strip">
              <div className="admin-console__stat">
                <span className="admin-console__stat-value">{state.plan || "custom"}</span>
                <span className="admin-console__stat-label">Plan</span>
              </div>
              <div className="admin-console__stat">
                <span className="admin-console__stat-value">{state.installedApps}</span>
                <span className="admin-console__stat-label">Installed apps</span>
              </div>
            </div>

            {state.custom && (
              <p className="admin-console__warning">
                This workspace&apos;s ceiling was set by hand and matches no plan in the
                catalogue, so nothing prices it. Moving it onto a plan is what makes it
                invoiceable.
              </p>
            )}
            {state.drifted && (
              <p className="admin-console__warning">
                The ceiling in force is not the one {state.annotatedPlan} describes. The cluster
                enforces what is there; what is billed is what is recorded. Re-applying a plan
                settles both.
              </p>
            )}

            {!state.hasQuota ? (
              <p className="admin-console__empty">
                This workspace runs without a ceiling — its apps may claim whatever the cluster
                has.
              </p>
            ) : (
              <div className="admin-console__table-wrap">
                <table className="admin-console__table">
                  <thead>
                    <tr>
                      <th>Resource</th>
                      <th>Committed</th>
                      <th>Ceiling</th>
                      <th>Headroom</th>
                      <th>In use now</th>
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
                                ? "no ceiling"
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
                Live consumption is {state.actualSource || "unavailable"}. Committed figures come
                from the quota the cluster enforces and are unaffected.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">Plans</h3>
        <p className="admin-console__lead">
          {isPlatformAdmin
            ? "Changing a tenant's plan commits to the deployments repository and Argo CD applies it on the next sync."
            : "Pick the plan this workspace should run on. A larger plan takes effect once the change syncs; a smaller one is refused while more than it allows is in use."}
        </p>

        {plansQuery.isLoading && <p className="admin-console__loading">Loading…</p>}
        {plansQuery.data?.length === 0 && (
          <p className="admin-console__empty">
            No resource plans are defined on this cluster.
          </p>
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
                    <span className="admin-console__badge admin-console__badge--ok">current</span>
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
                    {pending === plan.name ? "Applying…" : "Switch to this plan"}
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
                          `Shrink ${selected} to ${planLabel(plan)} anyway?\n\n${plan.blocked}\n\n` +
                            "Running pods keep running, but the cluster will refuse to recreate " +
                            "any that restart until usage fits.",
                        )
                      ) {
                        requestChange(plan, true);
                      }
                    }}
                  >
                    Force
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="admin-console__subsection">
        <div className="admin-console__section-head">
          <h3 className="admin-console__subsection-title">History</h3>
          <div className="admin-console__toggle-group" role="group" aria-label="Time range">
            {RANGES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`admin-console__btn${range === entry.id ? " admin-console__btn--primary" : " admin-console__btn--quiet"}`}
                aria-pressed={range === entry.id}
                onClick={() => setRange(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {usageQuery.isLoading && <p className="admin-console__loading">Loading…</p>}
        {usageQuery.isError && (
          <p className="admin-console__error">The usage history could not be loaded.</p>
        )}
        {usageQuery.data && samples.length === 0 && (
          <p className="admin-console__empty">
            No samples in this window. The platform records a workspace&apos;s ceiling and
            consumption on a timer, so history begins when sampling was switched on.
          </p>
        )}

        {chartedResources.map((resource) => (
          <UsageChart key={resource} resource={resource} samples={samples} />
        ))}
      </div>

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">Billed plan intervals</h3>
        <p className="admin-console__lead">
          What this window resolves to for invoicing: each stretch the workspace spent on one
          plan, and the SKU in effect over it.
        </p>

        {reportQuery.isLoading && <p className="admin-console__loading">Loading…</p>}
        {reportQuery.data?.incomplete && (
          <p className="admin-console__warning">
            Nothing is recorded about the plan in force when this window opened, so the table
            below covers only the changes inside it.
          </p>
        )}
        {reportQuery.data && reportQuery.data.intervals.length === 0 ? (
          <p className="admin-console__empty">No plan intervals in this window.</p>
        ) : (
          reportQuery.data && (
            <div className="admin-console__table-wrap">
              <table className="admin-console__table admin-console__table--numeric">
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>SKU</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Days</th>
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
  if (!state.hasQuota || state.quota.length === 0) {
    return <span className="admin-console__hint">no ceiling</span>;
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
