import { clearAccessToken, getAccessToken, getAuthConfig, redirectToLogin } from "@/auth/oidc";

const API_PREFIX = "/api/v1";

function parseApiError(body: string, fallback: string): string {
  try {
    const data = JSON.parse(body) as { detail?: string | { msg?: string }[] };
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail.map((item) => item.msg || "").filter(Boolean).join("; ") || fallback;
    }
  } catch {
    // plain text or HTML error body
  }
  const trimmed = body.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
    if (/504|Gateway time-out/i.test(trimmed)) {
      return "The server timed out. Please try again in a moment.";
    }
    if (/502|Bad gateway/i.test(trimmed)) {
      return "The server is temporarily unavailable. Please try again.";
    }
    return fallback;
  }
  return body || fallback;
}

async function fetchWithAuth<T>(url: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401 && !getAuthConfig().authDisabled) {
    clearAccessToken();
    await redirectToLogin();
    const retryToken = getAccessToken();
    const retry = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(retryToken ? { Authorization: `Bearer ${retryToken}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (!retry.ok) {
      const body = await retry.text();
      throw new Error(parseApiError(body, retry.statusText));
    }
    return retry.json() as Promise<T>;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(parseApiError(body, res.statusText));
  }
  return res.json() as Promise<T>;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith("/api/") ? path : `${API_PREFIX}${path}`;
  return fetchWithAuth<T>(url, init);
}

export type MeResponse = {
  sub: string;
  username: string;
  name?: string;
  email?: string;
  tenant?: string;
};
