import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError } from "@/api/client";
import {
  deleteRepository,
  fetchCredentials,
  fetchRepositories,
  NeedsConfirmation,
  saveRepository,
  setCredential,
  type ConfirmationRequired,
  type CredentialStatus,
  type RepositoryInput,
  type RepositoryView,
} from "@/api/credentials";
import "./admin.css";

/**
 * Credentials and repositories.
 *
 * Two rules this component exists inside, both enforced by the API rather than
 * here:
 *
 *   No credential value is ever rendered. The API cannot return one, so this
 *   shows whether a value exists, who set it and when — never the value. Lost
 *   credentials are rotated, not recovered, and the form says so.
 *
 *   The API decides what is dangerous. A 428 carries the reason and the string
 *   to retype; this renders that answer. Deciding it here as well would put the
 *   rules in two places, and the copy in the browser is the one an operator can
 *   skip.
 */
export function CredentialsSection() {
  const queryClient = useQueryClient();
  const credentialsQuery = useQuery({
    queryKey: ["admin", "credentials"],
    queryFn: fetchCredentials,
  });
  const repositoriesQuery = useQuery({
    queryKey: ["admin", "repositories"],
    queryFn: fetchRepositories,
  });

  if (credentialsQuery.isLoading) {
    return <p className="admin-console__loading">Loading credentials…</p>;
  }
  if (credentialsQuery.isError) {
    // The message, not a summary of it. apiFetch already distinguishes "the
    // upstream refused this token" from "the service is not reachable", and
    // replacing both with "unavailable" threw away the only text that said
    // which — leaving an operator to guess between a 503, a 502 and a 401.
    const detail = (credentialsQuery.error as Error)?.message ?? "";
    return (
      <section>
        <header className="admin-console__section-head">
          <h2 className="admin-console__section-title">Credentials</h2>
        </header>
        <p className="admin-console__error">Credentials cannot be read right now.</p>
        {detail ? <p className="admin-console__error"><code>{detail}</code></p> : null}
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => void credentialsQuery.refetch()}
        >
          Try again
        </button>
      </section>
    );
  }

  const credentials = credentialsQuery.data ?? [];
  const unsatisfied = credentials.filter((c) => !c.satisfied && !c.optional);

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Credentials</h2>
          <p className="admin-console__lead">
            Values are write-only. This shows whether a credential is present, who set it and
            when — never the value itself. A lost credential is rotated, not recovered.
          </p>
        </div>
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => void credentialsQuery.refetch()}
        >
          Refresh
        </button>
      </header>

      {unsatisfied.length > 0 ? (
        <p className="admin-console__warning" role="status">
          {unsatisfied.length} required credential{unsatisfied.length === 1 ? " is" : "s are"} not
          yet supplied.
        </p>
      ) : null}

      {credentials.length === 0 ? (
        <p className="admin-console__empty">No credentials are declared for your scope.</p>
      ) : (
        <ul className="admin-console__cards">
          {credentials.map((credential) => (
            <CredentialCard
              key={credential.name}
              credential={credential}
              onSaved={() =>
                void queryClient.invalidateQueries({ queryKey: ["admin", "credentials"] })
              }
            />
          ))}
        </ul>
      )}

      <RepositoriesPanel
        repositories={repositoriesQuery.data ?? []}
        loading={repositoriesQuery.isLoading}
        onChanged={() => {
          void queryClient.invalidateQueries({ queryKey: ["admin", "repositories"] });
          void queryClient.invalidateQueries({ queryKey: ["admin", "credentials"] });
        }}
      />
    </section>
  );
}

function CredentialCard({
  credential,
  onSaved,
}: {
  credential: CredentialStatus;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (fields: Record<string, string>) => setCredential(credential.name, fields),
    onSuccess: () => {
      // Clear immediately: a submitted value has no reason to stay in component
      // state, where a later render could put it somewhere it does not belong.
      setValues({});
      setOpen(false);
      onSaved();
    },
  });

  // Keyed by field name for O(1) lookup while rendering each input. Empty
  // when the error is not an ApiError, or carries no fields — an unreachable
  // endpoint, for instance, is not a claim about any one input.
  const fieldErrors: Record<string, string> =
    mutation.error instanceof ApiError && mutation.error.fields
      ? Object.fromEntries(mutation.error.fields.map((fe) => [fe.field, fe.message]))
      : {};

  const needsAttention = !credential.satisfied && !credential.optional;

  return (
    <li
      className={`admin-console__card${needsAttention ? " admin-console__card--attention" : ""}`}
    >
      <div className="admin-console__card-main">
        <div className="admin-console__card-title">
          {credential.displayName}
          <span
            className={`admin-console__badge ${
              credential.satisfied
                ? "admin-console__badge--ok"
                : credential.optional
                  ? "admin-console__badge--warn"
                  : "admin-console__badge--danger"
            }`}
          >
            {credential.satisfied ? "present" : credential.optional ? "not set" : "missing"}
          </span>
          {credential.tenant ? (
            <span className="admin-console__badge">tenant {credential.tenant}</span>
          ) : null}
        </div>

        {credential.description ? (
          <p className="admin-console__card-desc">{credential.description}</p>
        ) : null}

        {/* ESO's verdict, not a guess — a "missing" here means the value is
            genuinely absent from OpenBao rather than that something failed to
            start. */}
        {!credential.satisfied && credential.reason ? (
          <p className="admin-console__card-meta">{credential.reason}</p>
        ) : null}

        {credential.setBy ? (
          <p className="admin-console__card-meta">
            Set by {credential.setBy}
            {credential.updatedAt ? ` on ${new Date(credential.updatedAt).toLocaleString()}` : ""}
          </p>
        ) : null}
      </div>

      {open ? null : (
        <div className="admin-console__card-aside">
          <button type="button" className="admin-console__btn" onClick={() => setOpen(true)}>
            {credential.satisfied ? "Replace" : "Supply"}
          </button>
        </div>
      )}

      {open ? (
        <form
          className="admin-console__card-footer"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(values);
          }}
        >
          <div className="admin-console__stack">
            {credential.fields.map((field) => {
              const fieldError = fieldErrors[field.key];
              return (
                <label key={field.key} className="admin-console__label">
                  <span className="admin-console__label-text">{field.key}</span>
                  <input
                    type={field.secret ? "password" : "text"}
                    autoComplete={field.secret ? "new-password" : "off"}
                    value={values[field.key] ?? ""}
                    placeholder={field.example}
                    aria-invalid={fieldError ? true : undefined}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                    }
                  />
                  {/* Attributed to this field by the API — audience, claims and
                      the rest stay a form-level message below, because the
                      target rejecting basic auth cannot say which half was
                      wrong, and guessing one would point at the wrong box. */}
                  {fieldError ? <span className="admin-console__field-error">{fieldError}</span> : null}
                </label>
              );
            })}
          </div>

          {/* Validation runs against the real endpoint before anything is
              stored, so a rejection here is the target refusing the value —
              not a format check this form invented. Shown only when the
              failure is not already attributed to a field above, so the same
              reason is not repeated once per box and once as a banner. */}
          {mutation.isError && Object.keys(fieldErrors).length === 0 ? (
            <p className="admin-console__error">{(mutation.error as Error).message}</p>
          ) : null}

          <div className="admin-console__actions">
            <button
              type="submit"
              className="admin-console__btn admin-console__btn--primary"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Validating…" : "Save"}
            </button>
            <button
              type="button"
              className="admin-console__btn admin-console__btn--quiet"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function RepositoriesPanel({
  repositories,
  loading,
  onChanged,
}: {
  repositories: RepositoryView[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState<{
    name: string;
    input?: RepositoryInput;
    detail: ConfirmationRequired;
  } | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ name: string } & RepositoryInput>({
    name: "",
    // apps, not deployments: an additive catalogue alongside the cluster's is
    // what a tenant adds. deployments repoints what everything reconciles from,
    // which the API guards with a retype — offering it as an equal choice here
    // would invite the dangerous one by accident.
    role: "apps",
    type: "git",
    url: "",
    branch: "",
  });

  const run = async (name: string, input?: RepositoryInput, confirm?: string) => {
    setError(null);
    try {
      if (input) {
        await saveRepository(name, { ...input, confirm });
      } else {
        await deleteRepository(name, confirm);
      }
      setPending(null);
      setTyped("");
      setAdding(false);
      setDraft({ name: "", role: "apps", type: "git", url: "", branch: "" });
      onChanged();
    } catch (err) {
      if (err instanceof NeedsConfirmation) {
        setPending({ name, input, detail: err.detail });
        setTyped("");
        return;
      }
      setError((err as Error).message);
    }
  };

  return (
    <div className="admin-console__subsection">
      <h3 className="admin-console__subsection-title">Repositories</h3>
      <p className="admin-console__lead">
        Where your apps come from. The cluster&apos;s own repositories are listed but not
        editable — your apps depend on them.
      </p>

      {error ? <p className="admin-console__error">{error}</p> : null}

      {/* Adding a repository. The API already accepted this — saveRepository has
          existed since the panel did — but nothing ever called it with an input,
          so the capability was reachable only by hand. A tenant admin could see
          their repositories and not add one. */}
      {adding ? (
        <form
          className="admin-console__form"
          onSubmit={(event) => {
            event.preventDefault();
            const { name, ...input } = draft;
            void run(name.trim(), {
              ...input,
              url: input.url.trim(),
              branch: input.branch?.trim() || undefined,
            });
          }}
        >
          <label className="admin-console__field">
            Name
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="my-catalogue"
              required
            />
          </label>
          <label className="admin-console__field">
            Repository URL
            <input
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
              placeholder="https://github.com/acme/gentian-apps"
              required
            />
          </label>
          <label className="admin-console__field">
            Kind
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value as "git" | "oci" })}
            >
              <option value="git">git</option>
              <option value="oci">oci</option>
            </select>
          </label>
          {draft.type === "git" ? (
            <label className="admin-console__field">
              Branch
              <input
                value={draft.branch ?? ""}
                onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
                placeholder="main"
              />
            </label>
          ) : null}
          <p className="admin-console__hint">
            An additive app catalogue for this tenant. Its apps appear alongside the
            cluster&apos;s; removing it removes those apps.
          </p>
          <div className="admin-console__form-actions">
            <button type="submit" className="admin-console__btn admin-console__btn--primary">
              Add repository
            </button>
            <button
              type="button"
              className="admin-console__btn"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="admin-console__btn admin-console__btn--primary"
          onClick={() => setAdding(true)}
        >
          Add a repository
        </button>
      )}

      {loading ? (
        <p className="admin-console__loading">Loading repositories…</p>
      ) : repositories.length === 0 ? (
        <p className="admin-console__empty">No repositories are configured for your scope.</p>
      ) : (
        <ul className="admin-console__cards">
          {repositories.map((repo) => (
            <li key={repo.name} className="admin-console__card">
              <div className="admin-console__card-main">
                <div className="admin-console__card-title">
                  {repo.name}
                  <span className="admin-console__badge admin-console__badge--info">
                    {repo.role}
                  </span>
                  <span className="admin-console__badge">{repo.type}</span>
                  {!repo.owned ? <span className="admin-console__badge">cluster</span> : null}
                </div>
                <p className="admin-console__card-meta">
                  <code>{repo.url}</code>
                  {repo.branch ? ` (${repo.branch})` : ""}
                </p>
              </div>
              {repo.owned ? (
                <div className="admin-console__card-aside">
                  <button
                    type="button"
                    className="admin-console__btn admin-console__btn--danger"
                    onClick={() => void run(repo.name)}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* The danger zone. It appears only when the API says an operation is
          dangerous, and it repeats the exact string the API will compare —
          so the console cannot drift into asking for the wrong confirmation,
          or into skipping one. */}
      {pending ? (
        <div className="admin-console__danger" role="alertdialog" aria-labelledby="danger-zone-title">
          <h4 id="danger-zone-title" className="admin-console__danger-title">
            This cannot be undone
          </h4>
          <p>{pending.detail.error}</p>
          <label className="admin-console__label">
            <span className="admin-console__label-text">
              Type <code>{pending.detail.confirmWith}</code> to confirm
            </span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="admin-console__edit-actions">
            <button
              type="button"
              className="admin-console__btn admin-console__btn--danger-solid"
              disabled={typed !== pending.detail.confirmWith}
              onClick={() => void run(pending.name, pending.input, typed)}
            >
              I understand, continue
            </button>
            <button
              type="button"
              className="admin-console__btn"
              onClick={() => {
                setPending(null);
                setTyped("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
