import { getAccessToken } from "@/auth/oidc";

const API_BASE = "/api/v1";

/** Thrown on any non-2xx answer, carrying the status and the body's detail. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * One call to this component's own API, same origin.
 *
 * Under edge no Authorization header is sent, because getAccessToken returns
 * null there: the Gateway puts the zone's token on the request itself. Under
 * pkce the held token is sent. Either way the API, not this bundle, decides
 * what the caller may do.
 */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let detail = `API ${path} failed: ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string" && body.detail) {
        detail = body.detail;
      }
    } catch {
      // A body that is not JSON keeps the status line.
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export type MeResponse = {
  sub: string;
  username: string;
  name?: string;
  email?: string;
};

export type ItemsResponse = {
  tenant: string;
  user: string;
  items: unknown[];
  message: string;
};
