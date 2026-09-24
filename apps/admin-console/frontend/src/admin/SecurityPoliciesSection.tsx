import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  fetchSecurityPolicies,
  updateSecurityPolicies,
  type SecurityPolicies,
} from "@/api/admin";
import "./admin.css";

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
      setSuccess("Security policies saved.");
      await queryClient.invalidateQueries({ queryKey: ["admin", "security-policies", tenant] });
      await queryClient.invalidateQueries({ queryKey: ["admin", "members", tenant] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  if (policiesQuery.isLoading) {
    return <p>Loading security policies…</p>;
  }

  if (policiesQuery.isError) {
    return <p className="admin-console__error">Security policies are not available.</p>;
  }

  return (
    <section>
      <div className="admin-console__toolbar">
        <h2 className="admin-console__section-title">
          Security policies
        </h2>
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
          <legend>Password</legend>
          <div className="admin-console__field">
            <label htmlFor="password-min-length">Minimum length</label>
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
            Require digit
          </label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireLowercase}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireLowercase: e.target.checked }))
              }
            />
            Require lowercase letter
          </label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireUppercase}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireUppercase: e.target.checked }))
              }
            />
            Require uppercase letter
          </label>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.passwordRequireSpecialChars}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, passwordRequireSpecialChars: e.target.checked }))
              }
            />
            Require special character
          </label>
          <div className="admin-console__field">
            <label htmlFor="password-history">Password history (0 = off)</label>
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
            <label htmlFor="password-max-age">Max password age in days (0 = off)</label>
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
          <legend>Session</legend>
          <div className="admin-console__field">
            <label htmlFor="session-idle">SSO idle timeout (minutes)</label>
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
            <label htmlFor="session-max">Max session lifespan (hours)</label>
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
            Allow remember me
          </label>
        </fieldset>

        <fieldset className="admin-console__fieldset">
          <legend>Lockout</legend>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.bruteForceProtected}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, bruteForceProtected: e.target.checked }))
              }
            />
            Brute-force protection enabled
          </label>
          <div className="admin-console__field">
            <label htmlFor="max-failures">Max failed login attempts</label>
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
            <label htmlFor="lockout-duration">Lockout duration (seconds)</label>
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
          <legend>MFA (TOTP)</legend>
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={form.requireTotpAdmins}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, requireTotpAdmins: e.target.checked }))
              }
            />
            Require TOTP for tenant administrators
          </label>
          <div className="admin-console__field">
            <label htmlFor="require-totp-members">Require TOTP for members</label>
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
              <option value="none">Not required</option>
              <option value="optional">Optional (per-user only)</option>
              <option value="required">Required for all members</option>
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
          {saveMutation.isPending ? "Saving…" : "Save policies"}
        </button>
      </form>
    </section>
  );
}
