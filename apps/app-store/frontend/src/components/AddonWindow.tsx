import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/api/client";

export type Addon = {
  name: string;
  displayName: string;
  description?: string;
  logo?: string;
  license?: string;
  author?: string;
  edition?: string;
  requiresEntitlement?: boolean;
  entitled?: boolean;
};

export type AddonPackage = {
  name: string;
  displayName: string;
  description?: string;
  addons: string[];
};

type AddonWindow = {
  base: string;
  family: string;
  addons: Addon[];
  packages: AddonPackage[];
  selected: string[];
  // Whether Remove actually switches an addon off, or only stops activating it.
  // Derived by the backend from how the base activates addons.
  deselectBehaviour?: "disables" | "keeps-installed";
};

/**
 * Addon selection for one installed app.
 *
 * Addons are never installed on their own — they are activated inside a base — so
 * this is the only place they are offered, and they are deliberately absent from
 * the store grid.
 *
 * The whole selection is submitted, not a delta: clearing a checkbox has to reach
 * the backend as an absence, because that is how deactivation is expressed.
 */
export function AddonWindow({
  profile,
  appName,
  onClose,
  onSaved,
}: {
  profile: string;
  appName: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [data, setData] = useState<AddonWindow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Addons queued with Provision rather than plain Install.
  const [provisionFor, setProvisionFor] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AddonWindow>(`/tenant/apps/${encodeURIComponent(profile)}/addons`)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setSelected(new Set(res.selected ?? []));
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profile]);

  // Close on Escape so the window behaves like a dialog rather than a page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !saving && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const initial = useMemo(() => new Set(data?.selected ?? []), [data]);
  const dirty = useMemo(() => {
    if (selected.size !== initial.size) return true;
    for (const name of selected) if (!initial.has(name)) return true;
    return false;
  }, [selected, initial]);

  // Install and Provision are different acts, so they are different buttons —
  // a tick box cannot say which one it means. Wording and behaviour match the
  // app cards exactly: Install activates the addon and leaves access to group
  // membership; Provision also puts every existing tenant user in its group.
  function add(addon: Addon, withProvision: boolean) {
    if (addon.requiresEntitlement && !addon.entitled) return;
    setSelected((prev) => new Set([...prev, addon.name]));
    setProvisionFor((prev) => {
      const next = new Set(prev);
      withProvision ? next.add(addon.name) : next.delete(addon.name);
      return next;
    });
  }

  function remove(addon: Addon) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(addon.name);
      return next;
    });
    setProvisionFor((prev) => {
      const next = new Set(prev);
      next.delete(addon.name);
      return next;
    });
  }

  function applyPackage(pkg: AddonPackage) {
    // A preset adds its addons; it does not clear anything the user already chose,
    // so combining two presets is additive rather than a last-one-wins surprise.
    setSelected((prev) => new Set([...prev, ...pkg.addons]));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/tenant/apps/${encodeURIComponent(profile)}/addons`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addons: [...selected], provision: provisionFor.size > 0 }),
      });
      // The enable/disable runs when the app restarts, which takes minutes. Saying
      // only "updated" reads as "nothing happened" while you watch an unchanged app.
      const on = selected.size;
      const off = (data?.addons.length ?? 0) - on;
      onSaved(
        `${appName}: ${on} addon${on === 1 ? "" : "s"} on, ${off} off. ` +
          `${appName} is restarting to apply this — allow a few minutes.`,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Addons for ${appName}`}
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="text-lg font-semibold">Addons for {appName}</h2>
          <p className="mt-0.5 text-sm text-slate-600">
            Choose which features are switched on inside {appName}. Addons are not separate
            apps — they are turned on and off within this one.
          </p>
          {/* A button label alone does not say what it does. Spell out all three, and
              say explicitly what happens to data — that is the question the buttons
              cannot answer. */}
          <dl className="mt-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-medium text-slate-700">Install</dt>
              <dd>
                Turns the addon on. Who may use it is decided separately, by adding users
                to its access group.
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-medium text-slate-700">Provision</dt>
              <dd>Turns it on <strong>and</strong> grants it to every existing user now.</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 font-medium text-slate-700">Remove</dt>
              <dd>
                {/* Removal is not symmetric across bases, so the wording follows the
                    base rather than asserting one behaviour for all of them. A base
                    whose activation script reconciles on every start really does
                    switch the addon back off; one that activates through a one-way
                    install step (Odoo's `odoo-bin -i`) has no safe inverse, so
                    Remove only stops it being added again. Saying "nothing is
                    switched off" to a Nextcloud user would be simply untrue. */}
                {data?.deselectBehaviour === "disables"
                  ? <>Switches it back off. Nothing is deleted — its data is kept and
                      returns if you turn it on again.</>
                  : <>Stops adding it. Anything already installed stays, and nothing is
                      deleted — data is only removed by uninstalling {appName} itself
                      and choosing Purge.</>}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            Saving restarts {appName}, so changes take a few minutes to appear.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && <p className="text-sm text-slate-500">Loading…</p>}
          {error && (
            <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          {!loading && data && data.addons.length === 0 && (
            <p className="text-sm text-slate-500">This app has no addons.</p>
          )}

          {data && data.packages.length > 0 && (
            <div className="mb-4">
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
                Bundles
              </p>
              <div className="flex flex-wrap gap-2">
                {data.packages.map((pkg) => (
                  <button
                    key={pkg.name}
                    type="button"
                    onClick={() => applyPackage(pkg)}
                    title={pkg.description}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                  >
                    {pkg.displayName}
                  </button>
                ))}
              </div>
            </div>
          )}

          <ul className="space-y-2">
            {data?.addons.map((addon) => {
              const locked = Boolean(addon.requiresEntitlement && !addon.entitled);
              const installed = selected.has(addon.name);
              const provisioned = provisionFor.has(addon.name);
              const wasInstalled = initial.has(addon.name);
              return (
                <li
                  key={addon.name}
                  className="flex items-start justify-between gap-3 rounded-xl border border-slate-200 p-3"
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{addon.displayName}</span>
                      {installed && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800">
                          {provisioned ? "Provisioned" : "Installed"}
                        </span>
                      )}
                      {wasInstalled !== installed && (
                        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">
                          {installed ? "will be added" : "will be removed"}
                        </span>
                      )}
                      {locked && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                          Subscription required
                        </span>
                      )}
                    </span>
                    {addon.description && (
                      <span className="mt-0.5 block text-xs text-slate-500">{addon.description}</span>
                    )}
                  </span>

                  <span className="flex shrink-0 gap-1.5">
                    {installed ? (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => remove(addon)}
                        className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
                        title="Stops adding this addon. Nothing is deleted."
                      >
                        Remove
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={locked || saving}
                          onClick={() => add(addon, false)}
                          className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                          title="Installs the addon without adding any users to its access group."
                        >
                          Install
                        </button>
                        <button
                          type="button"
                          disabled={locked || saving}
                          onClick={() => add(addon, true)}
                          className="rounded-lg bg-slate-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                          title="Installs the addon and automatically adds all existing tenant users to its access group."
                        >
                          Provision
                        </button>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {saving ? "Applying…" : "Apply changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
