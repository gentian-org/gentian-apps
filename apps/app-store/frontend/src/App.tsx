import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";

type CatalogueApp = {
  name: string;
  displayName: string;
  description?: string;
  logo?: string;
  chartVersion: string;
  kernelRequirements: string[];
  installedCount: number;
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
  phase?: "pending" | "provisioning" | "ready";
  message?: string;
  conditions?: AppCondition[];
};

type CatalogueResponse = {
  apps: CatalogueApp[];
  catalogueRepo: string;
  catalogueBranch: string;
  lastUpdated?: string;
};

type InstalledResponse = {
  apps: InstalledApp[];
  ready: InstalledApp[];
  pending: InstalledApp[];
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
  const statusText = ready ? "Installed and ready" : app.message || "Pending";
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

export default function App() {
  const [catalogue, setCatalogue] = useState<CatalogueResponse | null>(null);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [selected, setSelected] = useState<CatalogueApp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [cat, inst] = await Promise.all([
      apiFetch<CatalogueResponse>("/catalogue/"),
      apiFetch<InstalledResponse>("/tenant/apps/installed"),
    ]);
    setCatalogue(cat);
    setInstalled(inst.apps);
    return inst.apps;
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
  const pendingApps = installed.filter((app) => !isAppReady(app));
  const hasPending = pendingApps.length > 0;

  useEffect(() => {
    if (!hasPending) {
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
  }, [hasPending, refresh]);

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
          ready: false,
          phase: result.phase === "ready" ? "ready" : "pending",
          message: result.message || "Install requested — provisioning in progress",
        });
        return next;
      });

      const apps = await refresh();
      const current = apps.find((app) => app.profile === profile);
      if (!current) {
        setInstalled((prev) => prev.filter((app) => app.profile !== profile));
        setNotice({
          kind: "error",
          text: `${label} install did not persist. The tenant may be GitOps-managed and Argo CD reverted the change — retry after the platform update or install via kubectl gentian apps install.`,
        });
        return;
      }
      if (isAppReady(current)) {
        setNotice({ kind: "success", text: `${label} is installed and ready.` });
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

  return (
    <main className="mx-auto min-h-screen max-w-6xl p-6 md:p-10">
      <header className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
          Gentian OS
        </p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">App Store</h1>
        <p className="mt-2 max-w-2xl text-slate-600">
          Browse available applications and install them for your tenant with one click.
        </p>
        {catalogue && (
          <p className="mt-3 text-xs text-slate-500">
            Catalogue: {catalogue.catalogueRepo} @ {catalogue.catalogueBranch}
          </p>
        )}
      </header>

      {notice && (
        <div className={`mb-6 rounded-lg border px-4 py-3 ${noticeStyles}`}>
          {notice.text}
        </div>
      )}

      {pendingApps.length > 0 && (
        <section className="mb-10">
          <h2 className="mb-4 text-lg font-semibold">Pending</h2>
          <p className="mb-4 text-sm text-slate-600">
            These apps are being provisioned. Status refreshes automatically every few seconds.
          </p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pendingApps.map((app) => (
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
        <h2 className="mb-4 text-lg font-semibold">Installed</h2>
        {readyApps.length === 0 ? (
          <p className="text-slate-500">No apps are fully ready yet.</p>
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
        <h2 className="mb-4 text-lg font-semibold">Catalogue</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(catalogue?.apps || []).map((app) => {
            const installedApp = installedByProfile.get(app.name);
            const ready = isAppReady(installedApp);
            const pending = Boolean(installedApp) && !ready;

            return (
              <article
                key={app.name}
                className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-200"
              >
                <div className="flex items-start gap-3">
                  {app.logo ? (
                    <img src={app.logo} alt="" className="h-10 w-10 rounded-lg object-contain" />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 text-sm font-bold text-indigo-700">
                      {app.displayName.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold">{app.displayName}</h3>
                    <p className="text-xs text-slate-500">v{app.chartVersion}</p>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 flex-1 text-sm text-slate-600">
                  {app.description || "No description."}
                </p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {app.kernelRequirements.map((req) => (
                    <span
                      key={req}
                      className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700"
                    >
                      {req}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelected(app)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                  >
                    Details
                  </button>
                  {ready ? (
                    <span className="text-sm font-medium text-emerald-700">Installed</span>
                  ) : pending ? (
                    <span
                      className="rounded-lg bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-800"
                      title={installedApp?.message}
                    >
                      Pending
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === app.name}
                      onClick={() => install(app.name)}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {busy === app.name ? "Installing…" : "Install"}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
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
            <h3 className="text-xl font-semibold">{selected.displayName}</h3>
            <p className="mt-2 text-sm text-slate-600">{selected.description}</p>
            <p className="mt-4 text-sm">
              <span className="font-medium">Profile:</span> {selected.name}
            </p>
            <p className="text-sm">
              <span className="font-medium">Chart version:</span> {selected.chartVersion}
            </p>
            <p className="text-sm">
              <span className="font-medium">Cluster installs:</span> {selected.installedCount}{" "}
              tenants
            </p>
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
