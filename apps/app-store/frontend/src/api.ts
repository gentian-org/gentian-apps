const TOKEN_KEY = "gentian_access_token";
const API_PREFIX = "/api/v1";

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function isEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function loginUrl(returnTo: string): string {
  return `/oauth/login?return_to=${encodeURIComponent(returnTo)}`;
}

/** Complete OIDC sign-in without breaking out of a cross-origin portal iframe. */
export function redirectToLogin(): Promise<void> {
  const target = loginUrl(window.location.href);

  if (!isEmbedded()) {
    window.location.assign(target);
    return new Promise(() => undefined);
  }

  return new Promise((resolve, reject) => {
    const popup = window.open(target, "gentian-app-store-auth", "width=520,height=720");
    if (!popup) {
      reject(
        new Error(
          "Sign-in was blocked. Allow pop-ups for this site, or open the App Store in a new tab.",
        ),
      );
      return;
    }

    const cleanup = () => {
      window.clearInterval(pollTimer);
      window.removeEventListener("storage", onStorage);
    };

    const finish = () => {
      cleanup();
      if (getAccessToken()) {
        resolve();
      } else {
        reject(new Error("Sign-in was cancelled or did not complete."));
      }
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === TOKEN_KEY && event.newValue) {
        finish();
      }
    };
    window.addEventListener("storage", onStorage);

    const pollTimer = window.setInterval(() => {
      if (getAccessToken()) {
        finish();
        return;
      }
      if (popup.closed) {
        finish();
      }
    }, 400);
  });
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
  if (res.status === 401) {
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
