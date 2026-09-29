import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  fetchSecurityPolicies,
  updateSecurityPolicies,
  type SecurityPolicies,
} from "@/api/admin";
import "./admin.css";
import { useTranslation } from "react-i18next";

type SecurityPoliciesSectionProps = {
  tenant: string;
};

const DEFAULT_FORM: SecurityPolicies = {
  passwordMinLength: 8,
  passwordRequireDigits: false,
  passwordRequireLowercase: false,
  passwordRequireUppercase: false,
  passwordRequireSpecialChars: false,
  passwordHistoryCount: 0,
  passwordMaxAgeDays: 0,
  ssoSessionIdleMinutes: 30,
  ssoSessionMaxHours: 10,
  rememberMe: false,
  bruteForceProtected: true,
  maxLoginFailures: 5,
  lockoutDurationSeconds: 900,
  requireTotpAdmins: false,
  requireTotpMembers: "none",
};

export function SecurityPoliciesSection({ tenant }: SecurityPoliciesSectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [form, setForm] = useState<SecurityPolicies>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const policiesQuery = useQuery({
    queryKey: ["admin", "security-policies", tenant],
    queryFn: () => fetchSecurityPolicies(tenant),
  });

  useEffect(() => {
    if (policiesQuery.data) {
      setForm(policiesQuery.data);
    }
  }, [policiesQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => updateSecurityPolicies(form, tenant),
    onSuccess: async (data) => {
      setForm(data);
      setError(null);
      setSuccess(t("securityPolicies.saved"));
      await queryClient.invalidateQueries({ queryKey: ["admin", "security-policies", tenant] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "members", tenant] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  if (policiesQuery.isLoading) {
    return <p>{t("securityPolicies.loadingSecurityPolicies")}</p>;
  }

  if (policiesQuery.isError) {
    return <p className="admin-console__error">{t("securityPolicies.securityPoliciesAreNotAvailable")}</p>;
  }

  return (
    <section>
      <div className="admin-console__toolbar">
        <h2 className="admin-console__section-title">
          {t("securityPolicies.securityPolicies")}</h2>
      </div>

      <form
        className="admin-console__form admin-console__form--wide"
        onSubmit={(event) => {
          event.preventDefault();
          setSuccess(null);
          saveMutation.mutate();
        }}
      >
        <fieldset className="admin-console__fieldset">
          <legend>{t("securityPolicies.password")}</legend>
          <div className="admin-console__field">
            <label htmlFor="password-min-length">{t("securityPolicies.minimumLength")}</label>
            <input
              id="password-min-length"
              type="number"
              min={4}
              max={128}
              value={form.passwordMinLength}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordMinLength: Number(e.target.value) }))
              }
            />
          </div>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireDigits}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireDigits: e.target.checked }))
              }
            />
            {t("securityPolicies.requireDigit")}</label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireLowercase}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireLowercase: e.target.checked }))
              }
            />
            {t("securityPolicies.requireLowercaseLetter")}</label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireUppercase}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireUppercase: e.target.checked }))
              }
            />
            {t("securityPolicies.requireUppercaseLetter")}</label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireSpecialChars}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireSpecialChars: e.target.checked }))
              }
            />
            {t("securityPolicies.requireSpecialCharacter")}</label>
          <div className="admin-console__field">
            <label htmlFor="password-history">{t("securityPolicies.passwordHistory0Off")}</label>
            <input
              id="password-history"
              type="number"
              min={0}
              max={24}
              value={form.passwordHistoryCount}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordHistoryCount: Number(e.target.value) }))
              }
            />
          </div>
          <div className="admin-console__field">
            <label htmlFor="password-max-age">{t("securityPolicies.maxPasswordAgeInDays")}</label>
            <input
              id="password-max-age"
              type="number"
              min={0}
              max={3650}
              value={form.passwordMaxAgeDays}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordMaxAgeDays: Number(e.target.value) }))
              }
            />
          </div>
        </fieldset>

        <fieldset className="admin-console__fieldset">
          <legend>{t("securityPolicies.session")}</legend>
          <div className="admin-console__field">
            <label htmlFor="session-idle">{t("securityPolicies.ssoIdleTimeoutMinutes")}</label>
            <input
              id="session-idle"
              type="number"
              min={1}
              max={1440}
              value={form.ssoSessionIdleMinutes}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, ssoSessionIdleMinutes: Number(e.target.value) }))
              }
            />
          </div>
          <div className="admin-console__field">
            <label htmlFor="session-max">{t("securityPolicies.maxSessionLifespanHours")}</label>
            <input
              id="session-max"
              type="number"
              min={1}
              max={720}
              value={form.ssoSessionMaxHours}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, ssoSessionMaxHours: Number(e.target.value) }))
              }
            />
          </div>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.rememberMe}
              onChange={(e) => setForm((prev) => ({ ...prev, rememberMe: e.target.checked }))}
            />
            {t("securityPolicies.allowRememberMe")}</label>
        </fieldset>

        <fieldset className="admin-console__fieldset">
          <legend>{t("securityPolicies.lockout")}</legend>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.bruteForceProtected}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, bruteForceProtected: e.target.checked }))
              }
            />
            {t("securityPolicies.bruteForceProtectionEnabled")}</label>
          <div className="admin-console__field">
            <label htmlFor="max-failures">{t("securityPolicies.maxFailedLoginAttempts")}</label>
            <input
              id="max-failures"
              type="number"
              min={1}
              max={100}
              disabled={!form.bruteForceProtected}
              value={form.maxLoginFailures}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, maxLoginFailures: Number(e.target.value) }))
              }
            />
          </div>
          <div className="admin-console__field">
            <label htmlFor="lockout-duration">{t("securityPolicies.lockoutDurationSeconds")}</label>
            <input
              id="lockout-duration"
              type="number"
              min={60}
              max={86400}
              disabled={!form.bruteForceProtected}
              value={form.lockoutDurationSeconds}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, lockoutDurationSeconds: Number(e.target.value) }))
              }
            />
          </div>
        </fieldset>

        <fieldset className="admin-console__fieldset">
          <legend>{t("securityPolicies.mfaTotp")}</legend>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.requireTotpAdmins}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, requireTotpAdmins: e.target.checked }))
              }
            />
            {t("securityPolicies.requireTotpForTenantAdministrators")}</label>
          <div className="admin-console__field">
            <label htmlFor="require-totp-members">{t("securityPolicies.requireTotpForMembers")}</label>
            <select
              id="require-totp-members"
              value={form.requireTotpMembers}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  requireTotpMembers: e.target.value as SecurityPolicies["requireTotpMembers"],
                }))
              }
            >
              <option value="none">{t("securityPolicies.notRequired")}</option>
              <option value="optional">{t("securityPolicies.optionalPerUserOnly")}</option>
              <option value="required">{t("securityPolicies.requiredForAllMembers")}</option>
            </select>
          </div>
        </fieldset>

        {error && <p className="admin-console__error">{error}</p>}
        {success && <p className="admin-console__success">{success}</p>}
        <button
          className="admin-console__btn admin-console__btn--primary"
          type="submit"
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending ? "Saving…" : t("securityPolicies.savePolicies")}
        </button>
      </form>
    </section>
  );
}
