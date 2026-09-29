import { useAuth } from "@/auth/AuthProvider";
import { getOidcConfig } from "@/auth/oidc";
import { Trans, useTranslation } from "react-i18next";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();

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
        {t("requireAuth.checkingSession")}</div>
    );
  }

  if (!authDisabled && !oidcConfigured) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-2 p-8 text-slate-600">
        <p className="font-medium text-slate-800">{t("requireAuth.oidcNotConfigured")}</p>
        <p className="text-sm">
          <Trans
            i18nKey="requireAuth.howToConfigure"
            components={{ code: <code className="text-xs" /> }}
          />
        </p>
      </div>
    );
  }

  if (!isAuthenticated && !authDisabled) {
    login();
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-600">
        {t("requireAuth.redirectingToSignIn")}</div>
    );
  }

  return <>{children}</>;
}
