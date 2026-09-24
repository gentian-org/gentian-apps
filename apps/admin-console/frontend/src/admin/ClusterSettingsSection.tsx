import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchClusterSettings,
  updateClusterSettings,
  type ClusterSetting,
} from "@/api/cluster";
import "./admin.css";

/**
 * The cluster's settings, as the director reads them from the Cluster claim in
 * the deployments repository, and writes them back as commits.
 *
 * Three things make this screen different from the rest of the console today,
 * and they are the pattern the other screens are meant to follow:
 *
 * 1. It holds no catalogue. Every setting on the page, what it means and what
 *    it accepts, comes from the director's answer. A setting added to the
 *    claim's schema appears here with no release of this console.
 * 2. It holds no credential and makes no authorisation decision. The caller's
 *    own token goes to the director, which asks the authorization store
 *    whether that person may read or change the cluster. A 403 is rendered as
 *    a refusal, not hidden behind a disabled button.
 * 3. It tells the truth about what a save is. A change is a commit to git that
 *    Argo CD has not applied yet, so the screen says committed and names the
 *    commit rather than claiming the cluster now matches.
 */
export function ClusterSettingsSection() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: ["cluster", "settings"],
    queryFn: () => fetchClusterSettings(),
  });
  // Only what the person actually touched. Sending back every setting would
  // make a one-field edit a commit that rewrites the whole claim, and the diff
  // is the record of who changed what.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [lastCommit, setLastCommit] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);

  const saveMutation = useMutation({
    mutationFn: (settings: Record<string, string>) => updateClusterSettings(settings),
    onSuccess: (result) => {
      setDraft({});
      setLastCommit(result.commit ?? null);
      setUnchanged(!result.changed);
      void queryClient.invalidateQueries({ queryKey: ["cluster", "settings"] });
    },
  });

  if (settingsQuery.isLoading) {
    return <p className="admin-console__loading">Loading cluster settings…</p>;
  }
  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <p className="admin-console__error">
        Cluster settings are unavailable. This needs the cluster's audit relation, and the
        director has to be reachable from this console.
      </p>
    );
  }

  const { cluster, settings } = settingsQuery.data;
  const pending = Object.keys(draft).length;

  // Group by the first segment of the path, which is how the claim itself is
  // organised: certificates together, mail together. No mapping table here --
  // a new group appears because the director returned one.
  const groups = new Map<string, ClusterSetting[]>();
  for (const setting of settings) {
    const dot = setting.path.indexOf(".");
    const group = dot === -1 ? "cluster" : setting.path.slice(0, dot);
    const list = groups.get(group);
    if (list) {
      list.push(setting);
    } else {
      groups.set(group, [setting]);
    }
  }

  const edit = (path: string, value: string) => {
    setLastCommit(null);
    setUnchanged(false);
    setDraft((current) => ({ ...current, [path]: value }));
  };

  const currentValue = (setting: ClusterSetting): string =>
    draft[setting.path] ?? setting.value ?? "";

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Cluster settings</h2>
          <p className="admin-console__lead">
            What <span className="admin-console__mono">{cluster}</span> is configured with. Each
            change is a commit to the deployments repository with you as its author, which Argo
            CD then applies. Nothing here is written to the cluster directly.
          </p>
        </div>
        {pending > 0 ? (
          <span className="admin-console__badge admin-console__badge--warn">
            {pending} unsaved
          </span>
        ) : null}
      </header>

      {lastCommit ? (
        <p className="admin-console__success">
          Committed as <span className="admin-console__mono">{lastCommit.slice(0, 8)}</span>. The
          cluster changes once Argo CD has synced it.
        </p>
      ) : null}
      {unchanged ? (
        <p className="admin-console__hint">
          Nothing to commit — the cluster already held those values.
        </p>
      ) : null}
      {saveMutation.isError ? (
        <p className="admin-console__error">
          {(saveMutation.error as Error).message || "The change was refused."}
        </p>
      ) : null}

      {[...groups.entries()].map(([group, entries]) => (
        <div className="admin-console__subsection" key={group}>
          <h3 className="admin-console__subsection-title">{group}</h3>
          <div className="admin-console__stack">
            {entries.map((setting) => {
              const id = `setting-${setting.path.replace(/\./g, "-")}`;
              const touched = setting.path in draft;
              return (
                <div
                  className={`admin-console__field${touched ? " admin-console__row--editing" : ""}`}
                  key={setting.path}
                >
                  <label className="admin-console__label" htmlFor={id}>
                    <span className="admin-console__label-text">{setting.path}</span>
                    {setting.oneOf && setting.oneOf.length > 0 ? (
                      <select
                        id={id}
                        value={currentValue(setting)}
                        onChange={(event) => edit(setting.path, event.target.value)}
                      >
                        {/* An unset setting is its own option, so choosing a
                            value is deliberate and the schema's default is
                            visible as the state it actually is. */}
                        {setting.value === undefined ? (
                          <option value="">not set — the default applies</option>
                        ) : null}
                        {setting.oneOf.map((choice) => (
                          <option value={choice} key={choice}>
                            {choice}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={id}
                        type="text"
                        value={currentValue(setting)}
                        placeholder={
                          setting.value === undefined ? "not set — the default applies" : undefined
                        }
                        onChange={(event) => edit(setting.path, event.target.value)}
                      />
                    )}
                  </label>
                  <p className="admin-console__hint">{setting.doc}</p>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="admin-console__form-footer">
        <button
          type="button"
          className="admin-console__btn admin-console__btn--primary"
          disabled={pending === 0 || saveMutation.isPending}
          onClick={() => saveMutation.mutate(draft)}
        >
          {saveMutation.isPending ? "Committing…" : `Commit ${pending || ""} change${pending === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          className="admin-console__btn admin-console__btn--quiet"
          disabled={pending === 0 || saveMutation.isPending}
          onClick={() => setDraft({})}
        >
          Discard
        </button>
      </div>
    </section>
  );
}
