/**
 * How this bundle knows who the person is.
 *
 * Two modes, and the difference is where the session lives.
 *
 * pkce: the bundle runs the authorization code flow as a public client,
 * keeps the access token, and sends it as a bearer on every API call. This is
 * what a component deployed outside the platform does.
 *
 * edge: the platform's Gateway holds the session, with the zone's one
 * confidential client, and forwards the zone's token to the API on routes
 * whose exposure says forwardToken. The bundle runs no code flow, holds no
 * token and no client secret, and sends no Authorization header: a request
 * with no live session is sent to sign in by the edge before it ever reaches
 * this code. What the caller may do is the director's answer, asked by the
 * API with the forwarded token. A component behind the platform's edge runs
 * this way, and the platform sets the mode.
 *
 * Configuration arrives at run time through window.__GENTIAN_CONFIG__, which
 * docker-entrypoint.sh renders into /config.js from the environment. VITE_*
 * values are the development fallback only: Vite freezes them into the
 * bundle, and one image serves every cluster.
 */
export type AuthMode = "pkce" | "edge";

export type OidcConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  authDisabled: boolean;
  authMode: AuthMode;
  kernelDomain: string;
};

type RuntimeConfig = {
  oidcIssuer?: string;
  oidcClientId?: string;
  oidcScopes?: string;
  authDisabled?: string;
  authMode?: string;
  kernelDomain?: string;
};

const TOKEN_STORAGE_KEY = "gentian.access_token";

function runtimeConfig(): RuntimeConfig {
  return (window as unknown as { __GENTIAN_CONFIG__?: RuntimeConfig }).__GENTIAN_CONFIG__ ?? {};
}

export function getOidcConfig(): OidcConfig {
  const runtime = runtimeConfig();
  return {
    issuer: runtime.oidcIssuer || import.meta.env.VITE_OIDC_ISSUER || "",
    clientId: runtime.oidcClientId || import.meta.env.VITE_OIDC_CLIENT_ID || "",
    // This origin's own root, never a build-time constant: a component is
    // served on a host per tenant, and a baked-in value can only be right
    // for one of them.
    redirectUri: `${window.location.origin}/`,
    scopes: runtime.oidcScopes || import.meta.env.VITE_OIDC_SCOPES || "openid profile email",
    authDisabled: (runtime.authDisabled ?? import.meta.env.VITE_AUTH_DISABLED) === "true",
    authMode: (runtime.authMode ?? import.meta.env.VITE_AUTH_MODE) === "edge" ? "edge" : "pkce",
    kernelDomain: runtime.kernelDomain || import.meta.env.VITE_KERNEL_DOMAIN || "",
  };
}

/** True when the platform's Gateway holds the session. */
export function isEdgeSession(): boolean {
  return getOidcConfig().authMode === "edge";
}

/**
 * The bearer to send, or null. Null under edge on purpose: the Gateway puts
 * the zone's token on the request itself, and a token this bundle held would
 * be one it had no business holding.
 */
export function getAccessToken(): string | null {
  const config = getOidcConfig();
  if (config.authDisabled || config.authMode === "edge") {
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

/** Where the edge ends its session: the Gateway's logout path on this host. */
export const EDGE_LOGOUT_PATH = "/oauth2/logout";

/**
 * Where the edge answers a sign-out that ends both sessions. The edge
 * authorization service reads the zone's ID token cookie, sends the person to
 * the realm with the hint that lets it end the session without asking, and
 * names the Gateway's logout as the way back. Only the edge can do this,
 * because only the edge holds that cookie.
 */
export const EDGE_SIGN_OUT_PATH = "/oauth2/sign-out";

/** Start the code flow. A no-op under edge: the Gateway does this. */
export function loginRedirect(returnTo = window.location.pathname): void {
  const config = getOidcConfig();
  if (config.authDisabled || config.authMode === "edge" || !config.issuer || !config.clientId) {
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
  if (config.authMode === "edge") {
    window.location.assign(EDGE_SIGN_OUT_PATH);
    return;
  }
  if (!config.issuer || !config.clientId) {
    return;
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: config.redirectUri,
  });
  window.location.href = `${config.issuer.replace(/\/$/, "")}/protocol/openid-connect/logout?${params}`;
}

/**
 * Under edge, always: a request that reached this bundle passed the Gateway,
 * which is the only authentication there is. Under pkce, whether a token is
 * held.
 */
export function isAuthenticated(): boolean {
  const config = getOidcConfig();
  if (config.authDisabled || config.authMode === "edge") {
    return true;
  }
  return Boolean(getAccessToken());
}

/**
 * Finish the code flow. A stub in this template: a real app exchanges the code
 * through its own backend with PKCE, never with a client secret in the
 * browser. Under edge there is no flow to finish and this returns false.
 */
export function handleOAuthCallback(): boolean {
  if (isEdgeSession()) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) {
    return false;
  }
  setAccessToken(`stub-token-for-${code.slice(0, 8)}`);
  const state = params.get("state") ?? "/";
  window.history.replaceState({}, "", state);
  return true;
}
