import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/api/client";

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
  tier?: CatalogueTier;
  license?: string;
  catalogueAction?: CatalogueAction;
  checkoutUrl?: string | null;
  licenceNotice?: string | null;
  requiresEntitlement?: boolean;
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
  phase?: "installing" | "ready";
  message?: string;
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

function isProApp(app: CatalogueApp): boolean {
  return app.tier === "pro" || app.requiresEntitlement === true;
}

function displayNameFor(profile: string, catalogue: CatalogueResponse | null): string {
  return catalogue?.apps.find((app) => app.name === profile)?.displayName || profile;
}

function isAppReady(app: InstalledApp | undefined): boolean {
  return app?.ready === true;
}

function AppListCard({
  app,
  catalogue,
  busy,
  onUninstall,
  onPurge,
}: {
  app: InstalledApp;
  catalogue: CatalogueResponse | null;
  busy: string | null;
  onUninstall: (profile: string) => void;
  onPurge: (profile: string) => void;
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
  onInstall: () => void;
  onBuy: () => void;
}) {
  const pro = isProApp(app);
  const ready = isAppReady(installedApp);
  const installing = Boolean(installedApp) && !ready;
  const showBuy = pro && app.catalogueAction === "buy" && !installedApp;

  const cardClass = pro
    ? "border-amber-200/90 bg-gradient-to-br from-amber-50 via-white to-violet-50 shadow-md shadow-amber-100/60 hover:border-amber-300 hover:shadow-lg hover:shadow-amber-100/80"
    : "border-slate-200/80 bg-slate-50/50 shadow-sm hover:border-slate-300 hover:bg-slate-50/80";

  const avatarClass = pro
    ? "bg-gradient-to-br from-amber-200 to-violet-200 text-amber-900"
    : "bg-slate-200/80 text-slate-600";

  const logoClass = pro ? "h-10 w-10 rounded-lg object-contain" : "h-10 w-10 rounded-lg object-contain opacity-90 saturate-[0.88]";

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
            <h3 className={`truncate font-semibold ${pro ? "text-slate-900" : "text-slate-700"}`}>
              {app.displayName}
            </h3>
            {pro ? (
              <span className="rounded-full bg-gradient-to-r from-amber-500 to-violet-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                Pro
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                Free
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">v{app.chartVersion}</p>
        </div>
      </div>

      <p className={`mt-3 line-clamp-3 flex-1 text-sm ${pro ? "text-slate-600" : "text-slate-500"}`}>
        {app.description || "No description."}
      </p>

      {pro && app.licenceNotice && showBuy && (
        <p className="mt-2 text-xs text-amber-800/90">{app.licenceNotice}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1">
        {app.kernelRequirements.map((req) => (
          <span
            key={req}
            className={`rounded-full px-2 py-0.5 text-xs ${
              pro ? "bg-amber-100/80 text-amber-900" : "bg-slate-100/90 text-slate-600"
            }`}
          >
            {req}
          </span>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onDetails}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-white/80"
        >
          Details
        </button>
        {ready ? (
          <span className="text-sm font-medium text-emerald-700">Ready</span>
        ) : installing ? (
          <span
            className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-800"
            title={installedApp?.message}
          >
            Installing
          </span>
        ) : showBuy ? (
          <button
            type="button"
            disabled={busy === app.name}
            onClick={onBuy}
            className="rounded-lg bg-gradient-to-r from-amber-500 via-orange-500 to-violet-600 px-4 py-1.5 text-sm font-semibold text-white shadow-md shadow-amber-300/40 transition hover:brightness-110 disabled:opacity-50"
          >
            {busy === app.name ? "Opening…" : "Buy"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy === app.name}
            onClick={onInstall}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            {busy === app.name ? "Installing…" : "Install"}
          </button>
        )}
      </div>
    </article>
  );
}

export function StorePage() {
  const [catalogue, setCatalogue] = useState<CatalogueResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [selected, setSelected] = useState<CatalogueApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    let nextInstalled: InstalledApp[] = [];

    const cataloguePromise = apiFetch<CatalogueResponse>("/catalogue/")
      .then((cat) => {
        setCatalogue(cat);
      })
      .catch((e: Error) => {
        if (e.message !== "Redirecting to sign in…") {
          setNotice({ kind: "error", text: `Catalogue: ${e.message}` });
        }
      });

    const installedPromise = apiFetch<InstalledResponse>("/tenant/apps/installed")
      .then((inst) => {
        setInstalled(inst.apps);
        nextInstalled = inst.apps;
      })
      .catch((e: Error) => {
        if (e.message !== "Redirecting to sign in…") {
          setNotice({ kind: "error", text: `App status: ${e.message}` });
        }
      });

    await Promise.all([cataloguePromise, installedPromise]);
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

  const installedByProfile = new Map(installed.map((app) => [app.profile, app]));
  const readyApps = installed.filter((app) => isAppReady(app));
  const installingApps = installed.filter((app) => !isAppReady(app));
  const hasInstalling = installingApps.length > 0;

  const catalogueApps = catalogue?.apps ?? [];

  useEffect(() => {
    if (!hasInstalling) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => {
      refresh().catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasInstalling, refresh]);

  async function install(profile: string) {
    setBusy(profile);
    setNotice(null);
    try {
      const result = await apiFetch<InstallResponse>(`/tenant/apps/${profile}/install`, {
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

      await refresh().catch(() => undefined);

      if (result.ready) {
        setNotice({ kind: "success", text: `${label} is ready.` });
      } else {
        setNotice({
          kind: "info",
          text: `${label} is installing. Status refreshes automatically until it becomes ready.`,
        });
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
            onInstall={() => install(app.name)}
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

      {notice && (
        <div className={`mb-6 rounded-lg border px-4 py-3 ${noticeStyles}`}>{notice.text}</div>
      )}

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
