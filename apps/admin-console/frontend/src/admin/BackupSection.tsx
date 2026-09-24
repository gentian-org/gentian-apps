import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  backupIsTerminal,
  createBackup,
  deleteBackup,
  fetchBackups,
  type Backup,
  type BackupCreateBody,
} from "@/api/admin";
import { BackupKeyChoice, type KeyChoice, type KeyDecision } from "@/admin/BackupKeyChoice";
import "./admin.css";

type BackupSectionProps = {
  tenant: string;
};

const POLL_MS = 5000;

function defaultName(): string {
  // Date-stamped, because a list of exports is only useful if you can tell at
  // a glance which one is which.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-").toLowerCase();
  return `export-${stamp}`;
}

function pauseWindow(app: Backup["apps"][number]): string {
  if (!app.quiesceStart) {
    return "—";
  }
  if (!app.quiesceEnd) {
    return "paused now";
  }
  const seconds = Math.max(
    0,
    Math.round((Date.parse(app.quiesceEnd) - Date.parse(app.quiesceStart)) / 1000),
  );
  return `${seconds}s`;
}

function formatTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

/** The phase colour: an export is fine, working, or broken — nothing in between. */
function phaseBadgeClass(phase: string): string {
  if (phase === "Ready") {
    return "admin-console__badge admin-console__badge--ok";
  }
  if (phase === "Failed") {
    return "admin-console__badge admin-console__badge--danger";
  }
  return "admin-console__badge admin-console__badge--info";
}

export function BackupSection({ tenant }: BackupSectionProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(defaultName);
  const [keyChoice, setKeyChoice] = useState<KeyChoice>("platform");
  const [keyDecision, setKeyDecision] = useState<KeyDecision>({
    choice: "platform",
    recipients: [],
    ready: true,
  });
  const mode: "recipient" | "passphrase" = keyChoice === "passphrase" ? "passphrase" : "recipient";
  const [target, setTarget] = useState<"policy" | "platform" | "custom">("policy");
  const [endpoint, setEndpoint] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [credentialSource, setCredentialSource] = useState<"managed" | "transient">("managed");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Names whose deletion was accepted but whose card is still in the list:
  // the operator holds a deleted export until its bundle is gone from
  // storage, so the entry lingers for a few seconds after the DELETE call.
  const [deleting, setDeleting] = useState<string[]>([]);

  const backupsQuery = useQuery({
    queryKey: ["admin", "backups", tenant],
    queryFn: () => fetchBackups(tenant),
    // Poll only while something can still change on its own — a running
    // export, or one whose deletion is still being carried out. A finished
    // list that keeps refetching is load with no new information.
    refetchInterval: (query) => {
      const data = query.state.data as Backup[] | undefined;
      if (!data) {
        return POLL_MS;
      }
      if (deleting.length > 0) {
        return POLL_MS;
      }
      return data.some((backup) => !backupIsTerminal(backup)) ? POLL_MS : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: BackupCreateBody) => createBackup(body, tenant),
    onSuccess: async (created) => {
      setError(null);
      setSuccess(
        mode === "passphrase"
          ? `Export ${created.name} started. Keep the passphrase safe — without it nobody can open this bundle, including support.`
          : `Export ${created.name} started.`,
      );
      setPassphrase("");
      setConfirmPassphrase("");
      // The keys were for one export. Leaving them in the form invites the
      // next backup to reuse credentials the person meant to use once.
      setAccessKey("");
      setSecretKey("");
      setName(defaultName());
      await queryClient.invalidateQueries({ queryKey: ["admin", "backups", tenant] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (vars: { name: string; force: boolean }) =>
      deleteBackup(vars.name, tenant, { force: vars.force }),
    onSuccess: async (_result, vars) => {
      setError(null);
      setSuccess(`Deleting ${vars.name} — the stored bundle is being removed.`);
      setDeleting((prev) => (prev.includes(vars.name) ? prev : [...prev, vars.name]));
      await queryClient.invalidateQueries({ queryKey: ["admin", "backups", tenant] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  const backups = backupsQuery.data ?? [];
  const running = backups.filter((backup) => !backupIsTerminal(backup));

  useEffect(() => {
    setDeleting((prev) => {
      const kept = prev.filter((name) => backups.some((backup) => backup.name === name));
      return kept.length === prev.length ? prev : kept;
    });
  }, [backups]);

  function confirmDelete(backup: Backup) {
    const terminal = backupIsTerminal(backup);
    const question = terminal
      ? `Delete backup "${backup.name}"? Its stored bundle is removed from object storage. This cannot be undone.`
      : `Abort the running backup "${backup.name}"? Paused apps are resumed, and anything captured so far is removed.`;
    if (window.confirm(question)) {
      deleteMutation.mutate({ name: backup.name, force: !terminal });
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (mode === "passphrase") {
      if (passphrase.length < 12) {
        setError("Use a passphrase of at least 12 characters.");
        return;
      }
      if (passphrase !== confirmPassphrase) {
        setError("The passphrases do not match.");
        return;
      }
    }

    // A key choice that was started and not finished — "a new key" with nothing
    // generated yet, or "a key I already have" with nothing pasted — would
    // otherwise submit as the platform key, quietly giving the backup to
    // exactly the reader the choice was made to exclude.
    if (!keyDecision.ready) {
      setError(
        keyDecision.choice === "new"
          ? "Generate the key first, and save it — the backup cannot be made without it."
          : "Enter the public key to encrypt this backup to.",
      );
      return;
    }

    if (target === "custom") {
      if (!endpoint.trim()) {
        setError("Enter the S3 endpoint to write this backup to.");
        return;
      }
      if (credentialSource === "transient" && (!accessKey.trim() || !secretKey.trim())) {
        setError("Enter both an access key and a secret key, or use the stored credentials.");
        return;
      }
    }

    createMutation.mutate({
      name,
      apps: [],
      encryption:
        mode === "passphrase"
          ? { mode, passphrase }
          : { mode, recipients: keyDecision.recipients },
      // Omitted for the default. Sending {mode: "policy"} would say the same
      // thing and leave a destination on the record that overrode nothing.
      ...(target === "policy"
        ? {}
        : {
            destination:
              target === "platform"
                ? { mode: "platform" as const }
                : {
                    mode: "custom" as const,
                    endpoint: endpoint.trim(),
                    bucket: bucket.trim(),
                    region: region.trim(),
                    credentialSource,
                    ...(credentialSource === "transient"
                      ? { accessKey: accessKey.trim(), secretKey: secretKey.trim() }
                      : {}),
                  },
          }),
    });
  }

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Backup</h2>
          <p className="admin-console__lead">
            An export captures this tenant — app databases, files and member accounts — into
            one encrypted bundle. Apps are paused one at a time while each is captured, so every
            app&apos;s data is internally consistent; the rest keep running.
          </p>
        </div>
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => void backupsQuery.refetch()}
        >
          Refresh
        </button>
      </header>

      {error && <p className="admin-console__error">{error}</p>}
      {success && <p className="admin-console__success">{success}</p>}

      <form className="admin-console__form admin-console__form--plain" onSubmit={submit}>
        <div className="admin-console__stack">
          <label className="admin-console__label">
            <span className="admin-console__label-text">Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="export-2026-08-18"
              required
            />
          </label>
        </div>

        <fieldset className="admin-console__fieldset admin-console__fieldset--plain">
          <legend>Where it goes</legend>

          <div className="admin-console__choices">
            <label
              className={`admin-console__choice${
                target === "policy" ? " admin-console__choice--selected" : ""
              }`}
            >
              <input
                type="radio"
                name="backup-target"
                checked={target === "policy"}
                onChange={() => setTarget("policy")}
              />
              <span>
                <span className="admin-console__choice-title">Where my backups normally go</span>
                <span className="admin-console__choice-desc">
                  The destination this workspace is configured for — the same place the nightly backup writes.
                </span>
              </span>
            </label>
            <label
              className={`admin-console__choice${
                target === "platform" ? " admin-console__choice--selected" : ""
              }`}
            >
              <input
                type="radio"
                name="backup-target"
                checked={target === "platform"}
                onChange={() => setTarget("platform")}
              />
              <span>
                <span className="admin-console__choice-title">This platform's own storage</span>
                <span className="admin-console__choice-desc">
                  A copy kept close, for just before a risky change. It shares a home with the data it protects, so it is not what you want for disaster recovery.
                </span>
              </span>
            </label>
            <label
              className={`admin-console__choice${
                target === "custom" ? " admin-console__choice--selected" : ""
              }`}
            >
              <input
                type="radio"
                name="backup-target"
                checked={target === "custom"}
                onChange={() => setTarget("custom")}
              />
              <span>
                <span className="admin-console__choice-title">My own S3 storage</span>
                <span className="admin-console__choice-desc">
                  A bucket you name, on a provider you name. For handing a copy to someone, or keeping one somewhere this platform cannot reach.
                </span>
              </span>
            </label>

            {/* Outside the radio label on purpose: a label nested in a label is
                invalid, and clicking the input would re-trigger the radio. */}
            {target === "custom" && (
              <div className="admin-console__choice-detail">
                <label className="admin-console__label">
                  <span className="admin-console__label-text">Endpoint</span>
                  <input
                    value={endpoint}
                    onChange={(event) => setEndpoint(event.target.value)}
                    placeholder="https://sos-ch-dk-2.exo.io"
                    required
                  />
                </label>
                <label className="admin-console__label">
                  <span className="admin-console__label-text">Bucket</span>
                  <input
                    value={bucket}
                    onChange={(event) => setBucket(event.target.value)}
                    placeholder="leave empty to keep this workspace's bucket name"
                  />
                </label>
                <label className="admin-console__label">
                  <span className="admin-console__label-text">Region</span>
                  <input
                    value={region}
                    onChange={(event) => setRegion(event.target.value)}
                    placeholder="ch-dk-2 — some providers need one, MinIO does not"
                  />
                </label>

                <div className="admin-console__choices">
                  <label
                    className={`admin-console__choice${
                      credentialSource === "managed" ? " admin-console__choice--selected" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="backup-credential-source"
                      checked={credentialSource === "managed"}
                      onChange={() => setCredentialSource("managed")}
                    />
                    <span>
                      <span className="admin-console__choice-title">Use my stored keys</span>
                      <span className="admin-console__choice-desc">
                        The credentials already held for this workspace — the ones the nightly
                        backup uses. Nothing to type, and nothing new to keep safe.
                      </span>
                    </span>
                  </label>

                  <label
                    className={`admin-console__choice${
                      credentialSource === "transient" ? " admin-console__choice--selected" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="backup-credential-source"
                      checked={credentialSource === "transient"}
                      onChange={() => setCredentialSource("transient")}
                    />
                    <span>
                      <span className="admin-console__choice-title">Enter keys for this backup</span>
                      <span className="admin-console__choice-desc">
                        Used for this backup only. They are kept while it runs and removed when it
                        finishes — they are not stored for next time.
                      </span>
                    </span>
                  </label>
                </div>

                {credentialSource === "transient" && (
                  <div className="admin-console__choice-detail">
                    <label className="admin-console__label">
                      <span className="admin-console__label-text">Access key</span>
                      <input
                        value={accessKey}
                        onChange={(event) => setAccessKey(event.target.value)}
                        autoComplete="off"
                        required
                      />
                    </label>
                    <label className="admin-console__label">
                      <span className="admin-console__label-text">Secret key</span>
                      <input
                        type="password"
                        value={secretKey}
                        onChange={(event) => setSecretKey(event.target.value)}
                        autoComplete="new-password"
                        required
                      />
                    </label>
                  </div>
                )}
              </div>
            )}
          </div>
        </fieldset>

        <BackupKeyChoice
          tenant={tenant}
          idPrefix="manual-backup"
          choice={keyChoice}
          onChoiceChange={setKeyChoice}
          onDecision={setKeyDecision}
          passphrase={{
            body: "Encrypted so only you can open it — not the platform, not support. If the passphrase is lost, the bundle cannot be recovered by anyone.",
            ready: passphrase.length >= 12 && passphrase === confirmPassphrase,
            fields: (
              <>
              <label className="admin-console__label">
                <span className="admin-console__label-text">Passphrase</span>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label className="admin-console__label">
                <span className="admin-console__label-text">Confirm passphrase</span>
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(event) => setConfirmPassphrase(event.target.value)}
                  minLength={12}
                  autoComplete="new-password"
                  required
                />
              </label>
              </>
            ),
          }}
        />

        <div className="admin-console__submit">
          <button
            type="submit"
            className="admin-console__btn admin-console__btn--primary"
            disabled={createMutation.isPending || running.length > 0}
          >
            {createMutation.isPending ? "Starting…" : "Start export"}
          </button>
          {running.length > 0 && (
            <p className="admin-console__hint">
              An export is already running. Only one runs at a time, so no app is paused by two at
              once.
            </p>
          )}
        </div>
      </form>

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">History</h3>

        {backupsQuery.isLoading && <p className="admin-console__loading">Loading…</p>}

        {!backupsQuery.isLoading && backups.length === 0 && (
          <p className="admin-console__empty">No exports yet.</p>
        )}

        <div className="admin-console__cards">
          {backups.map((backup) => (
            <article key={backup.name} className="admin-console__card">
              <div className="admin-console__card-main">
                <div className="admin-console__card-title">
                  <span className="admin-console__mono">{backup.name}</span>
                  <span className={phaseBadgeClass(backup.phase)}>
                    {backup.phase || "Pending"}
                  </span>
                  <span className="admin-console__badge">
                    {backup.encryptionMode === "passphrase" ? "your passphrase" : "platform key"}
                  </span>
                </div>

                {backup.message && (
                  <p className="admin-console__card-desc">{backup.message}</p>
                )}

                {backup.phase === "Ready" && !backup.platformReadable && (
                  <p className="admin-console__card-desc">
                    Only you can open this bundle.
                  </p>
                )}

                {backup.bundlePrefix && (
                  <p className="admin-console__card-meta">
                    <code>
                      {backup.bundleBucket}/{backup.bundlePrefix}
                    </code>
                  </p>
                )}
              </div>

              <div className="admin-console__card-aside admin-console__card-aside--top admin-console__hint">
                {formatTime(backup.completedAt ?? backup.startedAt ?? backup.createdAt)}
                <button
                  type="button"
                  className="admin-console__btn admin-console__btn--danger"
                  disabled={deleting.includes(backup.name) || deleteMutation.isPending}
                  onClick={() => confirmDelete(backup)}
                >
                  {deleting.includes(backup.name)
                    ? "Deleting…"
                    : backupIsTerminal(backup)
                      ? "Delete"
                      : "Abort"}
                </button>
              </div>

              {(backup.quiesced.length > 0 || backup.apps.length > 0 ||
                backup.phase === "Ready") && (
                <div className="admin-console__card-footer">
                  {backup.quiesced.length > 0 && (
                    <p className="admin-console__warning">
                      Paused right now: {backup.quiesced.join(", ")}. These apps stay offline
                      until this export finishes.
                    </p>
                  )}

                  {backup.apps.length > 0 && (
                    <div className="admin-console__table-wrap">
                      <table className="admin-console__table">
                        <thead>
                          <tr>
                            <th>App</th>
                            <th>State</th>
                            <th>Captured</th>
                            <th>Paused for</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backup.apps.map((app) => (
                            <tr key={app.name}>
                              <td>{app.name}</td>
                              <td>
                                {app.phase || "Pending"}
                                {app.message && (
                                  <span className="admin-console__hint"> — {app.message}</span>
                                )}
                              </td>
                              <td>{app.stores.length > 0 ? app.stores.join(", ") : "—"}</td>
                              <td>{pauseWindow(app)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {backup.phase === "Ready" && (
                    <p className="admin-console__hint">
                      The bundle stays in the platform&apos;s object storage at the location
                      above. <code>bundle-info.json</code> inside it is readable and names the
                      exact command that decrypts the rest.
                    </p>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
