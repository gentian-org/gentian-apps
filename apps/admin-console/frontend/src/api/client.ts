import { getAccessToken, isEdgeSession, redirectToLoginForExpiredSession } from "@/auth/oidc";

const API_BASE = "/api/v1";

/**
 * One entry of a failed request's per-field validation detail, when the
 * upstream attributes the failure to a specific field rather than the
 * request as a whole. Mirrors the credential manager's FieldError.
 */
export type FieldError = {
  field: string;
  message: string;
};

/**
 * Thrown by apiFetch on any non-2xx response. fields is populated only when
 * the body carries one — most endpoints never do, and existing catch sites
 * that read only .message are unaffected.
 */
export class ApiError extends Error {
  readonly fields?: FieldError[];
  constructor(message: string, fields?: FieldError[]) {
    super(message);
    this.name = "ApiError";
    this.fields = fields;
  }
}

/**
 * Paths whose 401 means "the upstream refused this token", not "your portal
 * session expired".
 *
 * The credential manager exchanges the caller's token with OpenBao and answers
 * 401 when that exchange fails — a wrong audience, a group matching no role, an
 * auth backend that does not exist yet. Treating that as an expired session
 * logged the operator out mid-click and destroyed the one message that said
 * what was actually wrong.
 */
const UPSTREAM_AUTH_PATHS = ["/credentials"];

function isUpstreamAuth(path: string): boolean {
  return UPSTREAM_AUTH_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
  );
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let detail = "";
    let fields: FieldError[] | undefined;
    try {
      const body = (await response.json()) as { detail?: unknown; error?: unknown; fields?: unknown };
      if (typeof body.detail === "string" && body.detail) {
        detail = `: ${body.detail}`;
      } else if (typeof body.error === "string" && body.error) {
        // The credential manager's shape, forwarded verbatim by the BFF proxy
        // rather than translated into FastAPI's own {"detail": ...}. Reading
        // only .detail missed this every time: a validation failure showed as
        // a bare status code with the actual reason sitting beside it under
        // the other key.
        detail = `: ${body.error}`;
      }
      if (Array.isArray(body.fields)) {
        fields = body.fields as FieldError[];
      }
    } catch {
      // Response body is not JSON.
    }
    if (response.status === 401 && isUpstreamAuth(path)) {
      // The detail carries which check failed — audience, claims, role or mount
      // — because the API classifies the refusal now. This message used to guess,
      // and told operators to check a group membership that was correct through
      // three separate causes, none of which was the group.
      throw new ApiError(
        `Not authorised by the credential manager${detail}. Your portal session is fine — ` +
          `OpenBao refused the token; the credential manager's log has OpenBao's own words.`,
      );
    }
    if (response.status === 401 && (token || isEdgeSession())) {
      redirectToLoginForExpiredSession();
    }
    throw new ApiError(`API ${path} failed: ${response.status}${detail}`, fields);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  if (!text) {
    return undefined as T;
  }
  if (isEdgeSession() && (response.headers.get("content-type") ?? "").includes("text/html")) {
    // The edge session ended between two requests: what came back is the
    // sign-in page, not an answer. Reload, and the edge signs in silently.
    redirectToLoginForExpiredSession();
    throw new ApiError(`API ${path}: the edge session has ended`);
  }
  return JSON.parse(text) as T;
}

export type MeResponse = {
  sub: string;
  username: string;
  name?: string;
  email?: string;
  tenant?: string;
  groups?: string[];
  isPlatformAdmin?: boolean;
  isTenantAdmin?: boolean;
  shellApps?: ShellApp[];
};

export type ShellApp = {
  id: string;
  title: string;
  icon: string;
  launchUrl: string | null;
  linkTarget?: string | null;
  authMode?: string | null;
  /** The app asks to be opened hidden at desktop mount; see gentianos.io/portal-preopen. */
  preopen?: boolean;
  builtin?: boolean;
};

/** A kernel console, as the director decides this person may open it. */
export type ClusterTile = {
  name: string;
  displayName: string;
  description: string;
  url: string;
  icon: string;
};

export type ClusterTilesResponse = {
  cluster: string;
  kernelDomain: string;
  tiles: ClusterTile[];
};

export type AppsResponse = {
  apps: ShellApp[];
};

export type PrefsResponse = {
  base: string | null;
  theme: unknown;
  hasBackground: boolean;
  backgroundUrl: string | null;
  customPrefs?: Record<string, any>;
};
