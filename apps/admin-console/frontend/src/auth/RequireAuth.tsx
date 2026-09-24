import { useAuth } from "@/auth/AuthProvider";
import { getOidcConfig } from "@/auth/oidc";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, authDisabled, login } = useAuth();
  const config = getOidcConfig();
  // Under edge the bundle needs no issuer and no client of its own: the
  // Gateway holds the session, and a request that reached this code passed
  // it. Asking for an issuer here would block every component behind the
  // platform's edge with a message about a setting it must not have.
  const oidcConfigured = config.authMode === "edge" || Boolean(config.issuer && config.clientId);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        Checking session…
      </div>
    );
  }

  if (!authDisabled && !oidcConfigured) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-2 p-8 text-slate-600">
        <p className="font-medium text-slate-800">OIDC not configured</p>
        <p className="text-sm">
          Set <code className="text-xs">OIDC_ISSUER</code> and{" "}
          <code className="text-xs">OIDC_CLIENT_ID</code> on the web container, or{" "}
          <code className="text-xs">AUTH_DISABLED=true</code> for local dev. Behind the
          platform&apos;s edge the platform sets <code className="text-xs">AUTH_MODE=edge</code>{" "}
          and none of these is needed.
        </p>
      </div>
    );
  }

  if (!isAuthenticated && !authDisabled) {
    login();
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        Redirecting to sign in…
      </div>
    );
  }

  return <>{children}</>;
}
