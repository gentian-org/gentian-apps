const TOKEN_KEY = "gentian_access_token";
const API_PREFIX = "/api/v1";

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function redirectToLogin(): void {
  const returnTo = encodeURIComponent(window.location.href);
  const loginUrl = `/oauth/login?return_to=${returnTo}`;
  (window.top ?? window).location.href = loginUrl;
}

function parseApiError(body: string, fallback: string): string {
  try {
    const data = JSON.parse(body) as { detail?: string | { msg?: string }[] };
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail.map((item) => item.msg || "").filter(Boolean).join("; ") || fallback;
    }
  } catch {
    // plain text error body
  }
  return body || fallback;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAccessToken();
  const url = path.startsWith("/api/") ? path : `${API_PREFIX}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    clearAccessToken();
    redirectToLogin();
    throw new Error("Redirecting to sign in…");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(parseApiError(body, res.statusText));
  }
  return res.json() as Promise<T>;
}
