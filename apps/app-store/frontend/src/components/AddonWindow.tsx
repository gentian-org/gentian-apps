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

  function toggle(addon: Addon) {
    if (addon.requiresEntitlement && !addon.entitled) return;
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(addon.name) ? next.delete(addon.name) : next.add(addon.name);
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
        body: JSON.stringify({ addons: [...selected] }),
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
          {/* Checkboxes alone do not say what they do. Spell out both directions, and
              say explicitly that nothing here deletes data — that is the question a
              tick box cannot answer. */}
          <dl className="mt-3 space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 font-medium text-slate-700">Ticked</dt>
              <dd>Switched on and available to your users.</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 font-medium text-slate-700">Unticked</dt>
              <dd>
                Switched off and hidden. Its data is <strong>kept</strong> — ticking it again
                restores everything.
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 font-medium text-slate-700">Never</dt>
              <dd>
                Nothing here deletes data. That only happens if you uninstall {appName} itself
                and choose Purge.
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
              const checked = selected.has(addon.name);
              return (
                <li key={addon.name}>
                  <label
                    className={`flex items-start gap-3 rounded-xl border p-3 ${
                      locked
                        ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-60"
                        : "cursor-pointer border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={checked}
                      disabled={locked || saving}
                      onChange={() => toggle(addon)}
                    />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{addon.displayName}</span>
                        {/* State as a word, not just a tick — "On"/"Off" answers what a
                            checkbox alone leaves ambiguous. */}
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] ${
                            checked
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-slate-200 text-slate-600"
                          }`}
                        >
                          {checked ? "On" : "Off"}
                        </span>
                        {initial.has(addon.name) !== checked && (
                          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">
                            {checked ? "will be switched on" : "will be switched off"}
                          </span>
                        )}
                        {locked && (
                          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-800">
                            Subscription required
                          </span>
                        )}
                      </span>
                      {addon.description && (
                        <span className="mt-0.5 block text-xs text-slate-500">
                          {addon.description}
                        </span>
                      )}
                      {addon.author && (
                        <span className="mt-0.5 block text-[11px] text-slate-400">
                          by {addon.author}
                        </span>
                      )}
                    </span>
                  </label>
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
