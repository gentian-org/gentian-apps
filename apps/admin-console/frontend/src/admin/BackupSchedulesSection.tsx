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
          <span className="admin-console__label-text">How often</span>
          <select
            value={form.frequency}
            onChange={(e) => setForm({ ...form, frequency: e.target.value as Frequency })}
          >
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
            <option value="custom">Custom (cron)</option>
          </select>
        </label>

        {form.frequency === "weekly" && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">Day</span>
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
            <span className="admin-console__label-text">Day of month</span>
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
            <span className="admin-console__label-text">Start at (UTC)</span>
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
          <span className="admin-console__label-text">Cron expression (UTC)</span>
          <input
            placeholder="0 3 * * *"
            value={form.custom}
            onChange={(e) => setForm({ ...form, custom: e.target.value })}
          />
        </label>
      )}

      <h4 className="admin-console__group-title">How many to keep</h4>
      <div className="admin-console__field-row">
        {(
          [
            ["keepLast", "Most recent"],
            ["keepDaily", "Days"],
            ["keepWeekly", "Weeks"],
            ["keepMonthly", "Months"],
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
          Cancel
        </button>
      </div>
    </div>
  );
}

export function BackupSchedulesSection({ tenant, isPlatformAdmin }: BackupSchedulesSectionProps) {
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
          <h2 className="admin-console__section-title">Scheduled backups</h2>
          <p className="admin-console__lead">
            What runs automatically, and when it last succeeded.
          </p>
        </div>
        {isPlatformAdmin && (
          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={allTenants}
              onChange={(e) => setAllTenants(e.target.checked)}
            />
            <span>All tenants</span>
          </label>
        )}
      </header>

      {error && <p className="admin-console__error">{error}</p>}

      {query.isLoading && <p className="admin-console__loading">Loading…</p>}

      {!query.isLoading && schedules.length === 0 && (
        <p className="admin-console__empty">
          Nothing runs automatically. Set a schedule in the backup settings below.
        </p>
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
                  <span className="admin-console__badge admin-console__badge--warn">paused</span>
                )}
                {s.managed && <span className="admin-console__badge">from settings</span>}
              </div>
              <p className="admin-console__card-desc">
                {describeSchedule(formFromCron(s.schedule, false), "")} Keeps {keptSummary(s.retention)}.
              </p>
              <p className="admin-console__card-meta">
                Last success {formatTime(s.lastSuccessfulTime)} · next {formatTime(s.nextScheduleTime)}
                {s.encryption.mode === "own"
                  ? " · encrypted to your own key"
                  : " · encrypted to the platform's key"}
              </p>
              {s.encryption.mode === "own" && (
                <p className="admin-console__hint">
                  Nobody here can read these backups. Restoring one needs the private key you
                  hold — keep it somewhere that survives losing this cluster.
                </p>
              )}
              {s.message && <p className="admin-console__warning">{s.message}</p>}
              {!s.lastSuccessfulTime && s.lastScheduleTime && (
                <p className="admin-console__warning">
                  Has run but never succeeded — a schedule that fails every night looks healthy
                  by every other measure.
                </p>
              )}
            </div>

            <div className="admin-console__card-aside admin-console__card-aside--top">
              {s.managed ? (
                <span className="admin-console__hint">Change in the settings below</span>
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
                    Delete
                  </button>
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
