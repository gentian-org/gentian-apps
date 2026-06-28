/**
 * App Store auth — backend BFF at /oauth/* with iframe-safe popup sign-in.
 * Token key matches the HTML callback from backend/app/api/routes/oauth.py.
 */

export const TOKEN_STORAGE_KEY = "gentian_access_token";

export type AuthConfig = {
  authDisabled: boolean;
};

export function getAuthConfig(): AuthConfig {
  return {
    authDisabled: import.meta.env.VITE_AUTH_DISABLED === "true",
  };
}

export function getAccessToken(): string | null {
  if (getAuthConfig().authDisabled) {
    return null;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function clearAccessToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
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
export function redirectToLogin(returnTo = window.location.href): Promise<void> {
  const target = loginUrl(returnTo);

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
      if (event.key === TOKEN_STORAGE_KEY && event.newValue) {
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

export function isAuthenticated(): boolean {
  if (getAuthConfig().authDisabled) {
    return true;
  }
  return Boolean(getAccessToken());
}

export function loginRedirect(returnTo = window.location.href): void {
  if (getAuthConfig().authDisabled) {
    return;
  }
  void redirectToLogin(returnTo);
}

export function logoutRedirect(): void {
  clearAccessToken();
}

/** BFF callback sets the token via inline HTML — nothing to parse on the SPA route. */
export function handleOAuthCallback(): boolean {
  return false;
}
