import { apiFetch } from "@/api/client";

export type CredentialStatus = {
  name: string;
  displayName: string;
  description?: string;
  phase: string;
  scope: string;
  tenant?: string;
  optional: boolean;
  vaultPath: string;
  fields: CredentialField[];
  validator?: string;
  satisfied: boolean;
  reason?: string;
  setBy?: string;
  updatedAt?: string;
};

export type CredentialField = {
  key: string;
  format?: string;
  secret?: boolean;
  minLength?: number;
  example?: string;
};

export type RepositoryView = {
  name: string;
  tenant?: string;
  role: "apps" | "deployments";
  type: "git" | "oci";
  url: string;
  branch?: string;
  writable: boolean;
  owned: boolean;
  credentialName?: string;
};

/**
 * The 428 body from the Credential Manager. The API decides what is dangerous
 * and what has to be retyped; this type is only the shape of that answer.
 * Deciding it again here would be a second copy of the rules, and the two would
 * eventually disagree.
 */
export type ConfirmationRequired = {
  error: string;
  confirmField: string;
  confirmWith: string;
  dangerous: true;
  requiresRetype: true;
};

export class NeedsConfirmation extends Error {
  readonly detail: ConfirmationRequired;
  constructor(detail: ConfirmationRequired) {
    super(detail.error);
    this.name = "NeedsConfirmation";
    this.detail = detail;
  }
}

export async function fetchCredentials(): Promise<CredentialStatus[]> {
  const res = await apiFetch<{ credentials: CredentialStatus[] }>("/credentials");
  return res.credentials ?? [];
}

/**
 * Values go in and never come back. The response carries metadata only, so
 * nothing here can put a credential back into the DOM.
 */
export async function setCredential(
  name: string,
  fields: Record<string, string>,
): Promise<void> {
  await apiFetch(`/credentials/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

export async function fetchRepositories(): Promise<RepositoryView[]> {
  const res = await apiFetch<{ repositories: RepositoryView[] }>("/credentials/repositories/list");
  return res.repositories ?? [];
}

export type RepositoryInput = {
  role: "apps" | "deployments";
  type: "git" | "oci";
  url: string;
  branch?: string;
  writable?: boolean;
  confirm?: string;
};

/**
 * apiFetch throws a plain Error on any non-2xx, which would turn "please
 * confirm" into "something went wrong". So the confirmation case is read from
 * the raw response before that happens.
 */
async function repositoryRequest(path: string, init: RequestInit): Promise<void> {
  const { getAccessToken } = await import("@/auth/oidc");
  const token = getAccessToken();
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.status === 428) {
    throw new NeedsConfirmation((await response.json()) as ConfirmationRequired);
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      detail = body.error ?? body.detail ?? "";
    } catch {
      // Not JSON; the status alone has to carry it.
    }
    throw new Error(detail || `Request failed: ${response.status}`);
  }
}

export async function saveRepository(name: string, input: RepositoryInput): Promise<void> {
  await repositoryRequest(`/credentials/repositories/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteRepository(name: string, confirm?: string): Promise<void> {
  const query = confirm ? `?confirm=${encodeURIComponent(confirm)}` : "";
  await repositoryRequest(`/credentials/repositories/${encodeURIComponent(name)}${query}`, {
    method: "DELETE",
  });
}
