import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/api/client";
import { AddonWindow } from "@/components/AddonWindow";
import { TenantQuotaBar, type QuotaResponse } from "@/components/TenantQuotaBar";

type CatalogueTier = "community" | "pro";
type CatalogueAction = "install" | "buy";

type CatalogueApp = {
  name: string;
  displayName: string;
  description?: string;
  logo?: string;
  chartVersion: string;
  kernelRequirements: string[];
  installedCount: number;
  hasAddons?: boolean;
  tier?: CatalogueTier;
  license?: string;
  catalogueAction?: CatalogueAction;
  checkoutUrl?: string | null;
  licenceNotice?: string | null;
  requiresEntitlement?: boolean;
  resources?: {
    requests?: {
      cpu?: string;
      memory?: string;
    };
    limits?: {
      cpu?: string;
      memory?: string;
    };
  };
};

type AppCondition = {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
};

type InstalledApp = {
  profile: string;
  name?: string;
  ready?: boolean;
  // "failing": the workload is broken (crash-looping, unpullable image,
  // unschedulable) rather than merely slow. Kubernetes keeps retrying, so this
  // can still recover — but it needs someone to look at it, which an
  // indefinite "Installing" never conveys.
  phase?: "installing" | "ready" | "failing";
  message?: string;
  failure?: string | null;
  conditions?: AppCondition[];
};

type CatalogueResponse = {
  apps: CatalogueApp[];
  catalogueRepo: string;
  catalogueBranch: string;
  commerceEnabled?: boolean;
  communityCount?: number;
  proCount?: number;
  tenantDomain?: string;
  lastUpdated?: string;
};

type InstalledResponse = {
  apps: InstalledApp[];
  ready: InstalledApp[];
  installing: InstalledApp[];
  lifecycleWarning?: string;
};

type InstallResponse = {
  status: string;
  mode: string;
  profile: string;
  phase?: string;
  ready?: boolean;
  message?: string;
};

type Notice = {
  kind: "success" | "error" | "info";
  text: string;
};

const STATUS_POLL_MS = 4000;
// Slow heartbeat once everything has settled: still enough to notice an app
// that breaks after install, without polling every 4s forever.
const IDLE_POLL_MS = 20000;
// How far behind the last successful sync may fall before the view admits it
// may be out of date. Comfortably above IDLE_POLL_MS so an ordinary tick that
// lands late never trips it.
const STALE_AFTER_MS = 60000;

function isProApp(app: CatalogueApp): boolean {
  return app.tier === "pro" || app.requiresEntitlement === true;
}

function displayNameFor(profile: string, catalogue: CatalogueResponse | null): string {
  return catalogue?.apps.find((app) => app.name === profile)?.displayName || profile;
}

function hasAddons(profile: string, catalogue: CatalogueResponse | null): boolean {
  return Boolean(catalogue?.apps.find((a) => a.name === profile)?.hasAddons);
}

function isAppReady(app: InstalledApp | undefined): boolean {
  return app?.ready === true;
}

function isAppFailing(app: InstalledApp | undefined): boolean {
  return app?.ready !== true && app?.phase === "failing";
}

function AppListCard({
  app,
  catalogue,
  busy,
  onUninstall,
  onPurge,
  onEditAddons,
}: {
  app: InstalledApp;
  catalogue: CatalogueResponse | null;
  busy: string | null;
  onUninstall: (profile: string) => void;
  onPurge: (profile: string) => void;
  onEditAddons?: (profile: string) => void;
}) {
  const ready = isAppReady(app);
  const statusText = ready ? "Ready" : app.message || "Installing";
  const statusClass = ready ? "text-emerald-700" : "text-amber-700";
  const isBusy = busy === app.profile;

  return (
    <li className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="min-w-0 pr-3">
        <p className="font-medium">{displayNameFor(app.profile, catalogue)}</p>
        <p className={`text-xs ${statusClass}`}>{statusText}</p>
      </div>
      <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
        {onEditAddons && (
          <button
            type="button"
            disabled={isBusy}
            onClick={() => onEditAddons(app.profile)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
            title="Choose which addons are enabled in this app"
          >
            Addons
          </button>
        )}
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onUninstall(app.profile)}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {isBusy ? "Working…" : "Uninstall"}
        </button>
        <button
          type="button"
          disabled={isBusy}
          onClick={() => onPurge(app.profile)}
          className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          title="Uninstall and permanently delete databases, storage, and secrets"
        >
          Purge
        </button>
      </div>
    </li>
  );
}

function CatalogueCard({
  app,
  installedApp,
  busy,
  onDetails,
  onInstall,
  onBuy,
}: {
  app: CatalogueApp;
  installedApp: InstalledApp | undefined;
  busy: string | null;
  onDetails: () => void;
  onInstall: (provision: boolean) => void;
  onBuy: () => void;
}) {
  const pro = isProApp(app);
  const installed = Boolean(installedApp);
  const ready = isAppReady(installedApp);
  const failing = isAppFailing(installedApp);
  const installing = installed && !ready && !failing;
  const showBuy = pro && app.catalogueAction === "buy" && !installed;

  let cardClass = "";
  let avatarClass = "";
  let logoClass = "";
  let badgeClass = "";
  let titleClass = "";
  let requirementClass = "";
  let descriptionClass = "";

  if (installed) {
    // Installed or installing app: Grey theme
    cardClass = "border-slate-200 bg-slate-50/80 shadow-none text-slate-500 hover:border-slate-300 hover:bg-slate-100/60";
    avatarClass = "bg-slate-200/80 text-slate-500";
    logoClass = "h-10 w-10 rounded-lg object-contain opacity-50 grayscale";
    titleClass = "truncate font-semibold text-slate-600";
    badgeClass = "rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500";
    requirementClass = "bg-slate-200/60 text-slate-500";
    descriptionClass = "mt-3 line-clamp-3 flex-1 text-sm text-slate-400";
  } else if (pro) {
    // Premium/Commercial app: Orange-Purple theme
    cardClass = "border-amber-200/90 bg-gradient-to-br from-amber-50 via-white to-violet-50 shadow-md shadow-amber-100/60 hover:border-amber-300 hover:shadow-lg hover:shadow-amber-100/80";
    avatarClass = "bg-gradient-to-br from-amber-200 to-violet-200 text-amber-900";
    logoClass = "h-10 w-10 rounded-lg object-contain";
    titleClass = "truncate font-semibold text-slate-900";
    badgeClass = "rounded-full bg-gradient-to-r from-amber-500 to-violet-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm";
    requirementClass = "bg-amber-100/80 text-amber-900";
    descriptionClass = "mt-3 line-clamp-3 flex-1 text-sm text-slate-600";
  } else {
    // Free app: Appealing Blue theme
    cardClass = "border-blue-200/80 bg-gradient-to-br from-blue-50/50 via-white to-sky-50/30 shadow-md shadow-blue-100/40 hover:border-blue-300 hover:shadow-lg hover:shadow-blue-100/60";
    avatarClass = "bg-gradient-to-br from-blue-200 to-sky-200 text-blue-900";
    logoClass = "h-10 w-10 rounded-lg object-contain opacity-95 saturate-[1.05]";
    titleClass = "truncate font-semibold text-slate-800";
    badgeClass = "rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-blue-700 shadow-sm";
    requirementClass = "bg-blue-100/80 text-blue-800";
    descriptionClass = "mt-3 line-clamp-3 flex-1 text-sm text-slate-500";
  }

  return (
    <article className={`flex flex-col rounded-xl border p-5 transition ${cardClass}`}>
      <div className="flex items-start gap-3">
        {app.logo ? (
          <img src={app.logo} alt="" className={logoClass} />
        ) : (
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold ${avatarClass}`}
          >
            {app.displayName.slice(0, 1)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={titleClass}>
              {app.displayName}
            </h3>
            <span className={badgeClass}>
              {installed ? "Installed" : pro ? "Pro" : "Free"}
            </span>
          </div>
          <p className={`text-xs ${installed ? "text-slate-400" : "text-slate-500"}`}>v{app.chartVersion}</p>
        </div>
      </div>

      <p className={descriptionClass}>
        {app.description || "No description."}
      </p>

      {pro && app.licenceNotice && showBuy && (
        <p className={`mt-2 text-xs ${installed ? "text-slate-400" : "text-amber-800/90"}`}>{app.licenceNotice}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1">
        {app.kernelRequirements.map((req) => (
          <span
            key={req}
            className={`rounded-full px-2 py-0.5 text-xs ${requirementClass}`}
          >
            {req}
          </span>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onDetails}
          className={`rounded-lg border px-3 py-1.5 text-sm transition ${
            installed 
              ? "border-slate-300 text-slate-500 hover:bg-slate-200/50" 
              : pro 
                ? "border-amber-300/80 text-amber-900/80 hover:bg-amber-100/50" 
                : "border-blue-300/80 text-blue-900/80 hover:bg-blue-100/50"
          }`}
        >
          Details
        </button>
        {ready ? (
          <span className="text-sm font-medium text-emerald-600 flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block"></span>
            Ready
          </span>
        ) : failing ? (
          // Not a spinner: nothing here resolves on its own. The reason is in
          // the tooltip because the card has no room for a pod-level message.
          <span
            className="rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-800 flex items-center gap-1.5"
            title={installedApp?.message ?? "The application failed to start"}
          >
            <span className="h-2 w-2 rounded-full bg-red-500 inline-block"></span>
            Needs attention
          </span>
        ) : installing ? (
          <span
            className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-800 flex items-center gap-1.5"
            title={installedApp?.message}
          >
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse inline-block"></span>
            Installing
          </span>
        ) : showBuy ? (
          <button
            type="button"
            disabled={busy === app.name}
            onClick={onBuy}
            className="rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-50"
          >
            {busy === app.name ? "Opening…" : "Buy"}
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy === app.name}
              onClick={() => onInstall(false)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition disabled:opacity-50 ${
                pro ? "bg-violet-600 hover:bg-violet-700" : "bg-blue-600 hover:bg-blue-700"
              }`}
              title="Installs the application without adding any users to its access group."
            >
              {busy === app.name ? "Installing…" : "Install"}
            </button>
            <button
              type="button"
              disabled={busy === app.name}
              onClick={() => onInstall(true)}
              className="rounded-lg bg-slate-700 hover:bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm transition disabled:opacity-50"
              title="Installs the application and automatically adds all existing tenant users to its access group."
            >
              {busy === app.name ? "Provisioning…" : "Provision"}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

export function StorePage() {
  const [catalogue, setCatalogue] = useState<CatalogueResponse | null>(null);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [selected, setSelected] = useState<CatalogueApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const [addonTarget, setAddonTarget] = useState<string | null>(null);
  const [optimisticInstalling, setOptimisticInstalling] = useState<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // What the *view* knows about its own freshness. Without this a poll that
  // stops working — an expired token, a hung request, a throttled background
  // tab — leaves the last successful snapshot on screen indefinitely, and a
  // stale screen that looks live is worse than a visibly stale one.
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    // A hung request must not let later ticks pile up behind it; each would
    // hold its own connection and none would ever report anything.
    if (inFlightRef.current) return [] as InstalledApp[];
    inFlightRef.current = true;
    let nextInstalled: InstalledApp[] = [];
    let failure: string | null = null;

    // Headroom is refreshed on the same tick as the app list, because the two
    // move together: an install that lands is also capacity that is gone.
    const quotaPromise = apiFetch<QuotaResponse>("/tenant/quota")
      .then((q) => {
        setQuota(q);
      })
      .catch(() => {
        // Deliberately not recorded as a sync failure. The header is an aid,
        // not the page; losing it must not mark the catalogue itself stale.
      });

    const cataloguePromise = apiFetch<CatalogueResponse>("/catalogue/")
      .then((cat) => {
        setCatalogue(cat);
      })
      .catch((e: Error) => {
        failure = `Catalogue: ${e.message}`;
      });

    const installedPromise = apiFetch<InstalledResponse>("/tenant/apps/installed")
      .then((inst) => {
        setInstalled(inst.apps);
        nextInstalled = inst.apps;
      })
      .catch((e: Error) => {
        failure = `App status: ${e.message}`;
      });

    try {
      await Promise.all([cataloguePromise, installedPromise, quotaPromise]);
    } finally {
      inFlightRef.current = false;
    }

    if (failure) {
      // Recorded rather than raised as a notice: a blocking red banner on every
      // failed background tick would bury whatever the user is actually doing,
      // and these recover on their own most of the time. The freshness
      // indicator carries it instead.
      setSyncError(failure);
    } else {
      setSyncError(null);
      setLastSyncAt(Date.now());
    }
    return nextInstalled;
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => {
      if (e.message !== "Redirecting to sign in…") {
        setNotice({ kind: "error", text: e.message });
      }
    });
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (installed.length > 0) {
      const installedProfiles = new Set(installed.map((app) => app.profile));
      setOptimisticInstalling((current) => {
        let changed = false;
        const next = { ...current };
        Object.keys(next).forEach((profile) => {
          if (installedProfiles.has(profile)) {
            delete next[profile];
            changed = true;
          }
        });
        return changed ? next : current;
      });
    }
  }, [installed]);

  useEffect(() => {
    if (notice?.kind === "info" && notice.text.includes("is installing")) {
      const match = notice.text.match(/^(.*) is installing\./);
      if (match) {
        const label = match[1];
        const app = installed.find((a) => displayNameFor(a.profile, catalogue) === label);
        if (app && isAppReady(app)) {
          setNotice({ kind: "success", text: `${label} is ready.` });
        } else if (app && isAppFailing(app)) {
          // Replace the "it will become ready" promise the moment that stops
          // being true — leaving it up is what made a broken install look like
          // a slow one.
          setNotice({
            kind: "error",
            text: `${label} failed to start: ${app.message ?? "the application is not running"}`,
          });
        }
      }
    }
  }, [installed, notice, catalogue]);

  // Merge optimistic installing state into the installed list
  const mergedInstalled = [...installed];
  const installedProfilesForMerge = new Set(installed.map((app) => app.profile));
  Object.entries(optimisticInstalling).forEach(([profile, message]) => {
    if (!installedProfilesForMerge.has(profile)) {
      mergedInstalled.push({
        profile,
        ready: false,
        phase: "installing",
        message,
      });
    }
  });

  const installedByProfile = new Map(mergedInstalled.map((app) => [app.profile, app]));
  const readyApps = mergedInstalled.filter((app) => isAppReady(app));
  const installingApps = mergedInstalled.filter((app) => !isAppReady(app));
  const hasInstalling = installingApps.length > 0;

  const catalogueApps = catalogue?.apps ?? [];

  // Stale means "the screen may not match reality": either the last attempt
  // failed, or no attempt has succeeded recently enough. A first load that has
  // not returned yet is not stale — it is simply still loading.
  const sinceSync = lastSyncAt === null ? null : Date.now() - lastSyncAt;
  const isStale =
    lastSyncAt === null ? syncError !== null : sinceSync !== null && sinceSync > STALE_AFTER_MS;
  const freshnessLabel =
    sinceSync === null
      ? "Loading status…"
      : sinceSync < 10000
        ? "Status up to date"
        : `Status updated ${Math.round(sinceSync / 1000)}s ago`;

  // Poll continuously, fast while something is in flight and slowly otherwise.
  // Stopping once everything was ready meant an app that broke *after* install
  // was never noticed: the store would keep showing "Ready" for a workload that
  // had been crash-looping for hours, which is the same lie in the opposite
  // direction as the endless "Installing".
  useEffect(() => {
    const period = hasInstalling ? STATUS_POLL_MS : IDLE_POLL_MS;
    const id = setInterval(() => {
      refresh().catch(() => undefined);
    }, period);
    pollRef.current = id;
    return () => {
      clearInterval(id);
      if (pollRef.current === id) pollRef.current = null;
    };
  }, [hasInstalling, refresh]);

  // Timers in a hidden or backgrounded tab are throttled hard by browsers — and
  // the store usually runs inside a portal iframe, so it is hidden whenever the
  // user looks at another app. Re-syncing the moment it becomes visible is what
  // makes the view match reality without a manual reload.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === "visible") {
        refresh().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("focus", resync);
    return () => {
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("focus", resync);
    };
  }, [refresh]);

  // Re-render on a timer so "updated Ns ago" ages visibly instead of freezing
  // at whatever it said when the last fetch happened to land.
  const [, setNow] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  async function install(profile: string, provision: boolean = false) {
    setBusy(profile);
    setNotice(null);
    try {
      const result = await apiFetch<InstallResponse>(`/tenant/apps/${profile}/install?provision=${provision}`, {
        method: "POST",
      });
      const label = displayNameFor(profile, catalogue);
      if (result.status === "already_installed") {
        await refresh();
        setNotice({ kind: "info", text: `${label} is already on this tenant.` });
        return;
      }

      setInstalled((current) => {
        const next = current.filter((app) => app.profile !== profile);
        next.push({
          profile,
          ready: result.ready === true,
          phase: result.ready ? "ready" : "installing",
          message: result.message || "Install requested — waiting for provisioning",
        });
        return next;
      });

      if (!result.ready) {
        setOptimisticInstalling((current) => ({
          ...current,
          [profile]: "Install requested — waiting for GitOps sync",
        }));
      }

      await refresh().catch(() => undefined);

      if (result.ready) {
        setNotice({ kind: "success", text: `${label} is ready.` });
      } else {
        setNotice({
          kind: "info",
          text: `${label} is installing. Status refreshes automatically until it becomes ready.`,
        });
      }

      // Choosing addons is part of setting the app up, so offer it now rather than
      // making the user find the Addons button afterwards. Safe before the app is
      // ready: the selection is written to the same tenant file the install just
      // committed, so it lands on the first deployment instead of forcing a restart.
      if (hasAddons(profile, catalogue)) {
        setAddonTarget(profile);
      }
    } catch (e) {
      setNotice({
        kind: "error",
        text: e instanceof Error ? e.message : "Install failed",
      });
    } finally {
      setBusy(null);
    }
  }

  function buy(app: CatalogueApp) {
    setBusy(app.name);
    setNotice(null);
    if (app.checkoutUrl) {
      window.location.href = app.checkoutUrl;
      return;
    }
    setNotice({
      kind: "info",
      text: `${app.displayName} requires a subscription. Checkout at gentian-corp will be available once commerce is configured (GENTIAN_COMMERCE_ENABLED).`,
    });
    setBusy(null);
  }

  async function uninstall(profile: string, purge = false) {
    setBusy(profile);
    setNotice(null);
    try {
      const query = purge ? "?purge=true" : "";
      const result = await apiFetch<{ status: string; warnings?: string[] }>(
        `/tenant/apps/${profile}${query}`,
        { method: "DELETE" },
      );
      await refresh();
      const label = displayNameFor(profile, catalogue);
      if (result.status === "not_installed" && !purge) {
        setNotice({ kind: "info", text: `${label} was not installed.` });
      } else if (purge) {
        const warn =
          result.warnings && result.warnings.length > 0
            ? ` Some steps reported warnings: ${result.warnings.join(" ")}`
            : "";
        setNotice({
          kind: "success",
          text: `${label} purged. Persistent data and kernel artifacts were removed.${warn}`,
        });
      } else {
        setNotice({ kind: "success", text: `${label} uninstall requested.` });
      }
    } catch (e) {
      setNotice({
        kind: "error",
        text: e instanceof Error ? e.message : purge ? "Purge failed" : "Uninstall failed",
      });
    } finally {
      setBusy(null);
      setPurgeTarget(null);
    }
  }

  function requestPurge(profile: string) {
    setPurgeTarget(profile);
  }

  const noticeStyles =
    notice?.kind === "error"
      ? "border-red-200 bg-red-50 text-red-800"
      : notice?.kind === "success"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-sky-200 bg-sky-50 text-sky-800";

  function renderCatalogueGrid(apps: CatalogueApp[]) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {apps.map((app) => (
          <CatalogueCard
            key={app.name}
            app={app}
            installedApp={installedByProfile.get(app.name)}
            busy={busy}
            onDetails={() => setSelected(app)}
            onInstall={(provision) => install(app.name, provision)}
            onBuy={() => buy(app)}
          />
        ))}
      </div>
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-6xl p-6 md:p-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
          Gentian OS
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">App Store</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Browse community and Pro apps in one catalogue. Free apps install immediately; Pro apps
          require a subscription.
        </p>
        {catalogue && (
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
            <span>
              Catalogue: {catalogue.catalogueRepo} @ {catalogue.catalogueBranch}
            </span>
            {typeof catalogue.communityCount === "number" && (
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-800">
                {catalogue.communityCount} free
              </span>
            )}
            {typeof catalogue.proCount === "number" && catalogue.proCount > 0 && (
              <span className="rounded-full bg-gradient-to-r from-amber-100 to-violet-100 px-2 py-0.5 font-medium text-amber-900">
                {catalogue.proCount} pro
              </span>
            )}
          </div>
        )}
      </header>

      <TenantQuotaBar quota={quota} />

      {notice && (
        <div className={`mb-6 rounded-lg border px-4 py-3 ${noticeStyles}`}>{notice.text}</div>
      )}

      {/* Freshness of the view itself, kept separate from any app's state: if
          this stops updating, everything above it is a snapshot of the past. */}
      <div className="mb-4 flex items-center gap-2 text-xs">
        {isStale ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />
            <span className="text-amber-700">
              {syncError
                ? `Status may be out of date — ${syncError}`
                : "Status may be out of date — reconnecting…"}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded border border-amber-300 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-50"
            >
              Retry now
            </button>
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
            <span className="text-slate-400">{freshnessLabel}</span>
          </>
        )}
      </div>

      {installingApps.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold">Installing</h2>
          <p className="mb-4 text-sm text-slate-600">
            These apps are on your tenant but not ready yet. Status refreshes automatically every
            few seconds.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {installingApps.map((app) => (
              <AppListCard
                key={app.profile}
                app={app}
                catalogue={catalogue}
                busy={busy}
                onUninstall={(profile) => uninstall(profile)}
                onPurge={requestPurge}
                onEditAddons={
                  // Also offered while installing: the selection is written to the
                  // tenant file, not to a running pod, so it can be made before the
                  // app comes up and takes effect on the first deployment.
                  hasAddons(app.profile, catalogue) ? () => setAddonTarget(app.profile) : undefined
                }
              />
            ))}
          </ul>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold">Ready</h2>
        {readyApps.length === 0 ? (
          <p className="text-slate-500">No apps are ready yet.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {readyApps.map((app) => (
              <AppListCard
                key={app.profile}
                app={app}
                catalogue={catalogue}
                busy={busy}
                onUninstall={(profile) => uninstall(profile)}
                onPurge={requestPurge}
                onEditAddons={
                  hasAddons(app.profile, catalogue) ? () => setAddonTarget(app.profile) : undefined
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold">Catalogue</h2>
          {catalogueApps.length > 0 && (
            <span className="text-sm text-slate-500">
              Community apps install for free; Pro apps show Buy until entitled.
            </span>
          )}
        </div>
        {catalogueApps.length === 0 ? (
          <p className="text-slate-500">No apps in the catalogue yet.</p>
        ) : (
          renderCatalogueGrid(catalogueApps)
        )}
      </section>

      {addonTarget && (
        <AddonWindow
          profile={addonTarget}
          appName={displayNameFor(addonTarget, catalogue)}
          onClose={() => setAddonTarget(null)}
          onSaved={(text) => {
            setNotice({ kind: "success", text });
            void refresh();
          }}
        />
      )}

      {purgeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-red-800">Purge app?</h3>
            <p className="mt-2 text-sm text-slate-600">
              This uninstalls{" "}
              <span className="font-medium">{displayNameFor(purgeTarget, catalogue)}</span> and
              permanently deletes its databases, object storage, OpenBao secrets, and kernel
              provisioning artifacts. This cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPurgeTarget(null)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy === purgeTarget}
                onClick={() => uninstall(purgeTarget, true)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy === purgeTarget ? "Purging…" : "Purge"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-semibold">{selected.displayName}</h3>
              {isProApp(selected) ? (
                <span className="rounded-full bg-gradient-to-r from-amber-500 to-violet-600 px-2 py-0.5 text-xs font-bold text-white">
                  Pro
                </span>
              ) : (
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  Free
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-600">{selected.description}</p>
            <p className="mt-4 text-sm">
              <span className="font-medium">Profile:</span> {selected.name}
            </p>
            {selected.license && (
              <p className="text-sm">
                <span className="font-medium">License:</span> {selected.license}
              </p>
            )}
            <p className="text-sm">
              <span className="font-medium">Chart version:</span> {selected.chartVersion}
            </p>
            <p className="text-sm">
              <span className="font-medium">Cluster installs:</span> {selected.installedCount}{" "}
              tenants
            </p>
            {selected.resources && (selected.resources.requests || selected.resources.limits) && (
              <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm border border-slate-100">
                <p className="font-semibold text-slate-700 mb-1">Resource Profile</p>
                {selected.resources.requests && (
                  <p className="text-slate-600">
                    <span className="font-medium">Requests:</span> CPU {selected.resources.requests.cpu || "—"}, Memory {selected.resources.requests.memory || "—"}
                  </p>
                )}
                {selected.resources.limits && (
                  <p className="text-slate-600">
                    <span className="font-medium">Limits:</span> CPU {selected.resources.limits.cpu || "—"}, Memory {selected.resources.limits.memory || "—"}
                  </p>
                )}
              </div>
            )}
            {isProApp(selected) && selected.licenceNotice && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {selected.licenceNotice}
              </p>
            )}
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mt-6 rounded-lg border border-slate-300 px-4 py-2 text-sm"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
