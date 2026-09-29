import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  deleteBackupSchedule,
  fetchBackupSchedules,
  saveBackupSchedule,
  type BackupSchedule,
  type BackupScheduleEncryption,
  type BackupRetention,
} from "@/api/admin";
import {
  cronFrom,
  describeSchedule,
  formFromCron,
  WEEKDAYS,
  type Frequency,
  type ScheduleForm,
} from "@/admin/backupSchedule";
import {
  BackupKeyChoice,
  type KeyChoice,
  type KeyDecision,
} from "@/admin/BackupKeyChoice";
import "./admin.css";
import { useTranslation } from "react-i18next";

type BackupSchedulesSectionProps = {
  tenant: string;
  isPlatformAdmin: boolean;
};

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function keptSummary(r: BackupRetention): string {
  const parts = [
    r.keepLast && `${r.keepLast} most recent`,
    r.keepDaily && `${r.keepDaily} daily`,
    r.keepWeekly && `${r.keepWeekly} weekly`,
    r.keepMonthly && `${r.keepMonthly} monthly`,
    r.keepYearly && `${r.keepYearly} yearly`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "everything";
}

function EditForm({
  schedule,
  onCancel,
  onSave,
  saving,
}: {
  schedule: BackupSchedule;
  onCancel: () => void;
  onSave: (
    form: ScheduleForm,
    retention: BackupRetention,
    encryption: BackupScheduleEncryption,
  ) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();

  const [form, setForm] = useState<ScheduleForm>(() =>
    formFromCron(schedule.schedule, false),
  );
  const [retention, setRetention] = useState<BackupRetention>(schedule.retention);
  const [keyChoice, setKeyChoice] = useState<KeyChoice>(
    schedule.encryption.mode === "own" ? "existing" : "platform",
  );
  const [keyDecision, setKeyDecision] = useState<KeyDecision>({
    choice: "platform",
    recipients: [],
    ready: true,
  });
  const showTime = ["daily", "weekly", "monthly"].includes(form.frequency);



  return (
    <div className="admin-console__card-footer">
      <div className="admin-console__field-row">
        <label className="admin-console__label">
          <span className="admin-console__label-text">{t("backupSchedules.howOften")}</span>
          <select
            value={form.frequency}
            onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}
          >
            <option value="daily">{t("backupSchedules.everyDay")}</option>
            <option value="weekly">{t("backupSchedules.everyWeek")}</option>
            <option value="monthly">{t("backupSchedules.everyMonth")}</option>
            <option value="custom">{t("backupSchedules.customCron")}</option>
          </select>
        </label>

        {form.frequency === "weekly" && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupSchedules.day")}</span>
            <select
              value={form.weekday}
              onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}

        {form.frequency === "monthly" && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupSchedules.dayOfMonth")}</span>
            <select
              value={form.monthday}
              onChange={(e) => setForm({ ...form, monthday: Number(e.target.value) })}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}

        {showTime && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupSchedules.startAtUtc")}</span>
            <input
              type="time"
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
            />
          </label>
        )}
      </div>

      {form.frequency === "custom" && (
        <label className="admin-console__label">
          <span className="admin-console__label-text">{t("backupSchedules.cronExpressionUtc")}</span>
          <input
            placeholder="0 3 * * *"
            value={form.custom}
            onChange={(e) => setForm({ ...form, custom: e.target.value })}
          />
        </label>
      )}

      <h4 className="admin-console__group-title">{t("backupSchedules.howManyToKeep")}</h4>
      <div className="admin-console__field-row">
        {(
          [
            ["keepLast", t("backupSchedules.retentionLast")],
            ["keepDaily", t("backupSchedules.retentionDaily")],
            ["keepWeekly", t("backupSchedules.retentionWeekly")],
            ["keepMonthly", t("backupSchedules.retentionMonthly")],
            ["keepYearly", "Years"],
          ] as [keyof BackupRetention, string][]
        ).map(([key, label]) => (
          <label key={key} className="admin-console__label">
            <span className="admin-console__label-text">{label}</span>
            <input
              type="number"
              min={0}
              value={retention[key]}
              onChange={(e) =>
                setRetention({ ...retention, [key]: Number(e.target.value) || 0 })
              }
            />
          </label>
        ))}
      </div>

      <BackupKeyChoice
        tenant={schedule.tenant}
        idPrefix={`schedule-${schedule.name}`}
        choice={keyChoice}
        onChoiceChange={setKeyChoice}
        onDecision={setKeyDecision}
      />

      <p className="admin-console__hint">{describeSchedule(form, "")}</p>

      <div className="admin-console__submit">
        <button
          type="button"
          className="admin-console__btn admin-console__btn--primary"
          disabled={saving || !keyDecision.ready || !cronFrom(form)}
          onClick={() =>
            onSave(form, retention, {
              mode: keyChoice === "platform" ? "platform" : "own",
              // Cleared when the platform key is chosen, so going back actually
              // goes back rather than leaving a key nobody here can read.
              recipients: keyChoice === "platform" ? [] : keyDecision.recipients,
            })
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="admin-console__btn" onClick={onCancel}>
          {t("backupSchedules.cancel")}</button>
      </div>
    </div>
  );
}

export function BackupSchedulesSection({ tenant, isPlatformAdmin }: BackupSchedulesSectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [allTenants, setAllTenants] = useState(isPlatformAdmin);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ["admin", "backup-schedules", tenant, allTenants],
    queryFn: () => fetchBackupSchedules(tenant, allTenants),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["admin", "backup-schedules"] });

  const save = useMutation({
    mutationFn: (vars: {
      schedule: BackupSchedule;
      form: ScheduleForm;
      retention: BackupRetention;
      encryption: BackupScheduleEncryption;
    }) =>
      saveBackupSchedule(
        vars.schedule.name,
        {
          schedule: cronFrom(vars.form),
          suspended: vars.schedule.suspended,
          retention: vars.retention,
          encryption: vars.encryption,
        },
        vars.schedule.tenant,
      ),
    onSuccess: async () => {
      setError(null);
      setEditing(null);
      await invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const remove = useMutation({
    mutationFn: (s: BackupSchedule) => deleteBackupSchedule(s.name, s.tenant),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const suspend = useMutation({
    mutationFn: (s: BackupSchedule) =>
      saveBackupSchedule(
        s.name,
        // The schedule's own encryption, restated: this endpoint replaces the
        // spec, so omitting it would quietly move a tenant's backups back to
        // the platform's key on a pause and resume.
        {
          schedule: s.schedule,
          suspended: !s.suspended,
          retention: s.retention,
          encryption: s.encryption,
        },
        s.tenant,
      ),
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err: Error) => setError(err.message),
  });

  const schedules = query.data ?? [];

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("backupSchedules.scheduledBackups")}</h2>
          <p className="admin-console__lead">
            {t("backupSchedules.whatRunsAutomaticallyAndWhen")}</p>
        </div>
        {isPlatformAdmin && (
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={allTenants}
              onChange={(e) => setAllTenants(e.target.checked)}
            />
            <span>{t("backupSchedules.allTenants")}</span>
          </label>
        )}
      </header>

      {error && <p className="admin-console__error">{error}</p>}

      {query.isLoading && <p className="admin-console__loading">{t("backupSchedules.loading")}</p>}

      {!query.isLoading && schedules.length === 0 && (
        <p className="admin-console__empty">
          {t("backupSchedules.nothingRunsAutomaticallySetA")}</p>
      )}

      <div className="admin-console__cards">
        {schedules.map((s) => (
          <article key={`${s.tenant}/${s.name}`} className="admin-console__card">
            <div className="admin-console__card-main">
              <div className="admin-console__card-title">
                <span className="admin-console__mono">
                  {allTenants ? `${s.tenant} / ${s.name}` : s.name}
                </span>
                {s.suspended && (
                  <span className="admin-console__badge admin-console__badge--warn">{t("backupSchedules.paused")}</span>
                )}
                {s.managed && <span className="admin-console__badge">{t("backupSchedules.fromSettings")}</span>}
              </div>
              <p className="admin-console__card-desc">
                {describeSchedule(formFromCron(s.schedule, false), "")} {t("backupSchedules.keeps")}{keptSummary(s.retention)}.
              </p>
              <p className="admin-console__card-meta">
                {t("backupSchedules.lastAndNext", {
                  last: formatTime(s.lastSuccessfulTime),
                  next: formatTime(s.nextScheduleTime),
                })}
                {t(
                  s.encryption.mode === "own"
                    ? "backupSchedules.encryptedOwnKey"
                    : "backupSchedules.encryptedPlatformKey",
                )}
              </p>
              {s.encryption.mode === "own" && (
                <p className="admin-console__hint">
                  {t("backupSchedules.nobodyHereCanReadThese")}</p>
              )}
              {s.message && <p className="admin-console__warning">{s.message}</p>}
              {!s.lastSuccessfulTime && s.lastScheduleTime && (
                <p className="admin-console__warning">
                  {t("backupSchedules.hasRunButNeverSucceeded")}</p>
              )}
            </div>

            <div className="admin-console__card-aside admin-console__card-aside--top">
              {s.managed ? (
                <span className="admin-console__hint">{t("backupSchedules.changeInTheSettingsBelow")}</span>
              ) : (
                <div className="admin-console__actions">
                  <button
                    type="button"
                    className="admin-console__btn"
                    onClick={() => setEditing(editing === s.name ? null : s.name)}
                  >
                    {editing === s.name ? "Close" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="admin-console__btn"
                    disabled={suspend.isPending}
                    onClick={() => suspend.mutate(s)}
                  >
                    {s.suspended ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    className="admin-console__btn admin-console__btn--danger"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete the schedule "${s.name}"? Backups it already made are kept.`)) {
                        remove.mutate(s);
                      }
                    }}
                  >
                    {t("backupSchedules.delete")}</button>
                </div>
              )}
            </div>

            {editing === s.name && !s.managed && (
              <EditForm
                schedule={s}
                saving={save.isPending}
                onCancel={() => setEditing(null)}
                onSave={(form, retention, encryption) =>
                  save.mutate({ schedule: s, form, retention, encryption })
                }
              />
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
