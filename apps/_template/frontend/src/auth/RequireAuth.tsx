import { useAuth } from "@/auth/AuthProvider";
import { getOidcConfig } from "@/auth/oidc";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, authDisabled, login } = useAuth();
  const config = getOidcConfig();
  const oidcConfigured = Boolean(config.issuer && config.clientId);

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
          Set <code className="text-xs">VITE_OIDC_ISSUER</code> and{" "}
          <code className="text-xs">VITE_OIDC_CLIENT_ID</code> at build time, or{" "}
          <code className="text-xs">VITE_AUTH_DISABLED=true</code> for local dev.
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
