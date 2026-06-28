/**
 * OIDC configuration from Vite env (M1, M3).
 * In cluster, the web pod receives these via ConfigMap or build-time args.
 */
export type OidcConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  authDisabled: boolean;
};

const TOKEN_STORAGE_KEY = "gentian.access_token";

export function getOidcConfig(): OidcConfig {
  return {
    issuer: import.meta.env.VITE_OIDC_ISSUER ?? "",
    clientId: import.meta.env.VITE_OIDC_CLIENT_ID ?? "",
    redirectUri: import.meta.env.VITE_OIDC_REDIRECT_URI ?? `${window.location.origin}/`,
    scopes: import.meta.env.VITE_OIDC_SCOPES ?? "openid profile email",
    authDisabled: import.meta.env.VITE_AUTH_DISABLED === "true",
  };
}

export function getAccessToken(): string | null {
  const config = getOidcConfig();
  if (config.authDisabled) {
    return null;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setAccessToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearAccessToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Redirect to Keycloak / OIDC authorize endpoint. Wire PKCE in production. */
export function loginRedirect(returnTo = window.location.pathname): void {
  const config = getOidcConfig();
  if (config.authDisabled || !config.issuer || !config.clientId) {
    return;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes,
    state: returnTo,
  });

  window.location.href = `${config.issuer.replace(/\/$/, "")}/protocol/openid-connect/auth?${params}`;
}

export function logoutRedirect(): void {
  clearAccessToken();
  const config = getOidcConfig();
  if (!config.issuer || !config.clientId) {
    return;
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: config.redirectUri,
  });
  window.location.href = `${config.issuer.replace(/\/$/, "")}/protocol/openid-connect/logout?${params}`;
}

export function isAuthenticated(): boolean {
  const config = getOidcConfig();
  if (config.authDisabled) {
    return true;
  }
  return Boolean(getAccessToken());
}

/**
 * Stub: exchange ?code= for tokens via backend or direct token endpoint.
 * Production apps should use PKCE + backend token exchange — never store client_secret in the browser.
 */
export function handleOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) {
    return false;
  }

  // Stub — replace with POST to /api/v1/auth/callback or oidc-client-ts
  setAccessToken(`stub-token-for-${code.slice(0, 8)}`);
  const state = params.get("state") ?? "/";
  window.history.replaceState({}, "", state);
  return true;
}
