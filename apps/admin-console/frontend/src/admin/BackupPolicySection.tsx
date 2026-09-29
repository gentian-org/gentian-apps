import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  emptyRetention,
  fetchBackupPolicy,
  fetchClusterBackupPolicy,
  resetBackupPolicy,
  saveBackupPolicy,
  saveClusterBackupPolicy,
  type BackupPolicy,
  type BackupPolicyBody,
  type BackupRetention,
} from "@/api/admin";
import {
  cronFrom,
  defaultSchedule,
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
import { Trans, useTranslation } from "react-i18next";

type BackupPolicySectionProps = {
  tenant: string;
  isPlatformAdmin: boolean;
};

type StorageMode = "platform" | "external";

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Draft = {
  storage: StorageMode;
  endpoint: string;
  bucket: string;
  region: string;
  schedule: ScheduleForm;
  retention: BackupRetention;
  keyChoice: KeyChoice;
  allowTenantOverride: boolean;
};

function draftFrom(policy: BackupPolicy | undefined): Draft {
  const endpoint = policy?.destination.endpoint ?? "";
  return {
    storage: endpoint ? "external" : "platform",
    endpoint,
    bucket: policy?.destination.bucket ?? "",
    region: policy?.destination.region ?? "",
    schedule: formFromCron(policy?.schedule ?? "", policy?.suspendSchedule ?? false),
    retention: policy?.retention ?? emptyRetention,
    keyChoice: policy?.encryption.mode === "own" ? "existing" : "platform",
    allowTenantOverride: policy?.allowTenantOverride ?? true,
  };
}

function bodyFrom(draft: Draft, recipients: string[], confirm?: string): BackupPolicyBody {
  const external = draft.storage === "external";
  return {
    destination: {
      endpoint: external ? draft.endpoint.trim() : "",
      bucket: draft.bucket.trim(),
      region: external ? draft.region.trim() : "",
    },
    schedule: cronFrom(draft.schedule),
    suspendSchedule: draft.schedule.frequency === "off",
    retention: draft.retention,
    encryption: {
      // Cleared rather than kept when the platform key is chosen, so going back
      // actually goes back. A list left behind would keep writing bundles the
      // platform cannot read while the form said otherwise.
      mode: draft.keyChoice === "platform" ? "platform" : "own",
      recipients: draft.keyChoice === "platform" ? [] : recipients,
    },
    confirm,
  };
}

// Keys rather than words: this array is module scope, where a hook cannot
// reach, and a label resolved once at import time would be in whatever
// language the page happened to load in.
const RETENTION_TIERS: { key: keyof BackupRetention; labelKey: string; hintKey: string }[] = [
  { key: "keepLast", labelKey: "retentionLast", hintKey: "retentionLastHint" },
  { key: "keepDaily", labelKey: "retentionDaily", hintKey: "retentionDailyHint" },
  { key: "keepWeekly", labelKey: "retentionWeekly", hintKey: "retentionWeeklyHint" },
  { key: "keepMonthly", labelKey: "retentionMonthly", hintKey: "retentionMonthlyHint" },
  { key: "keepYearly", labelKey: "retentionYearly", hintKey: "retentionYearlyHint" },
];

function RetentionFields({
  value,
  onChange,
}: {
  value: BackupRetention;
  onChange: (next: BackupRetention) => void;
}) {
  const { t } = useTranslation();

  const nothingKept = RETENTION_TIERS.every((tier) => value[tier.key] === 0);
  return (
    <>
      <div className="admin-console__field-row">
        {RETENTION_TIERS.map((tier) => (
          <label key={tier.key} className="admin-console__label">
            <span className="admin-console__label-text">{t(`backupPolicy.${tier.labelKey}`)}</span>
            <input
              type="number"
              min={0}
              value={value[tier.key]}
              onChange={(e) => onChange({ ...value, [tier.key]: Number(e.target.value) || 0 })}
            />
            <span className="admin-console__hint">{t(`backupPolicy.${tier.hintKey}`)}</span>
          </label>
        ))}
      </div>
      <p className="admin-console__hint">
        {t(nothingKept ? "backupPolicy.nothingDeleted" : "backupPolicy.keptByAnyRow")}
      </p>
    </>
  );
}

function ScheduleFields({
  value,
  onChange,
  allowInherit,
  inherited,
}: {
  value: ScheduleForm;
  onChange: (next: ScheduleForm) => void;
  allowInherit: boolean;
  inherited: string;
}) {
  const { t } = useTranslation();

  const showTime = ["daily", "weekly", "monthly"].includes(value.frequency);
  return (
    <div className="admin-console__stack">
      <div className="admin-console__field-row">
        <label className="admin-console__label">
          <span className="admin-console__label-text">{t("backupPolicy.howOften")}</span>
          <select
            value={value.frequency}
            onChange={(e) => onChange({ ...value, frequency: e.target.value as Frequency })}
          >
            {allowInherit && <option value="inherit">{t("backupPolicy.sameAsTheCluster")}</option>}
            <option value="off">{t("backupPolicy.neverOnlyWhenIStart")}</option>
            <option value="daily">{t("backupPolicy.everyDay")}</option>
            <option value="weekly">{t("backupPolicy.everyWeek")}</option>
            <option value="monthly">{t("backupPolicy.everyMonth")}</option>
            <option value="custom">{t("backupPolicy.customCron")}</option>
          </select>
        </label>

        {value.frequency === "weekly" && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupPolicy.day")}</span>
            <select
              value={value.weekday}
              onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}

        {value.frequency === "monthly" && (
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupPolicy.dayOfMonth")}</span>
            <select
              value={value.monthday}
              onChange={(e) => onChange({ ...value, monthday: Number(e.target.value) })}
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
            <span className="admin-console__label-text">{t("backupPolicy.startAtUtc")}</span>
            <input
              type="time"
              value={value.time}
              onChange={(e) => onChange({ ...value, time: e.target.value })}
            />
            <span className="admin-console__hint">{t("backupPolicy.oneRunNotAWindow")}</span>
          </label>
        )}
      </div>

      {value.frequency === "custom" && (
        <label className="admin-console__label">
          <span className="admin-console__label-text">{t("backupPolicy.cronExpressionUtc")}</span>
          <input
            placeholder="0 3 * * *"
            value={value.custom}
            onChange={(e) => onChange({ ...value, custom: e.target.value })}
          />
        </label>
      )}

      <p className="admin-console__hint">{describeSchedule(value, inherited)}</p>
    </div>
  );
}

function StorageFields({
  draft,
  setDraft,
  platformLabel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  platformLabel: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="admin-console__stack">
      <label className="admin-console__label">
        <span className="admin-console__label-text">{t("backupPolicy.whereBackupsAreStored")}</span>
        <select
          value={draft.storage}
          onChange={(e) => setDraft({ ...draft, storage: e.target.value as StorageMode })}
        >
          <option value="platform">{platformLabel}</option>
          <option value="external">{t("backupPolicy.externalStorageS3Compatible")}</option>
        </select>
      </label>

      {draft.storage === "external" && (
        <>
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupPolicy.endpoint")}</span>
            <input
              placeholder={t("backupPolicy.httpsSosChGva2")}
              value={draft.endpoint}
              onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
            />
            <span className="admin-console__hint">
              {t("backupPolicy.theProviderSS3Address")}</span>
          </label>
          <label className="admin-console__label">
            <span className="admin-console__label-text">{t("backupPolicy.region")}</span>
            <input
              placeholder={t("backupPolicy.chGva2")}
              value={draft.region}
              onChange={(e) => setDraft({ ...draft, region: e.target.value })}
            />
            <span className="admin-console__hint">{t("backupPolicy.requiredBySomeProvidersLeave")}</span>
          </label>
        </>
      )}

      <label className="admin-console__label">
        <span className="admin-console__label-text">{t("backupPolicy.bucket")}</span>
        <input
          placeholder={t(draft.storage === "external" ? "backupPolicy.myBackups" : "backupPolicy.leaveEmptyDefault")}
          value={draft.bucket}
          onChange={(e) => setDraft({ ...draft, bucket: e.target.value })}
        />
      </label>
    </div>
  );
}

/** What applies after inheritance, and whether it can actually be used. */
function EffectiveSummary({ policy }: { policy: BackupPolicy }) {
  const { t } = useTranslation();

  const where = policy.effectiveEndpoint
    ? `${policy.effectiveEndpoint}/${policy.effectiveBucket}`
    : t("backupPolicy.platformStorageBucket", { bucket: policy.effectiveBucket });
  return (
    <div className="admin-console__card-footer">
      <p className="admin-console__card-meta">
        {t("backupPolicy.inForce")}<code>{where}</code>
        {policy.effectiveSchedule
          ? t("backupPolicy.scheduleUtc", { schedule: policy.effectiveSchedule })
          : t("backupPolicy.noSchedule")}
        {t(
          policy.effectiveRecipients.length > 0
            ? "backupPolicy.encryptedOwnKey"
            : "backupPolicy.encryptedPlatformKey",
        )}
      </p>
      {policy.credentialRequirement && !policy.credentialSatisfied && (
        <p className="admin-console__warning">
          <Trans
            i18nKey="backupPolicy.waitingForKeys"
            values={{ credential: policy.credentialRequirement }}
            components={{ code: <code /> }}
          />
        </p>
      )}
    </div>
  );
}

export function BackupPolicySection({ tenant, isPlatformAdmin }: BackupPolicySectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const clusterQuery = useQuery({
    queryKey: ["admin", "backup-policy", "cluster"],
    queryFn: fetchClusterBackupPolicy,
    enabled: isPlatformAdmin,
  });
  const tenantQuery = useQuery({
    queryKey: ["admin", "backup-policy", tenant],
    queryFn: () => fetchBackupPolicy(tenant),
  });

  const [clusterDraft, setClusterDraft] = useState<Draft>(() => draftFrom(undefined));
  const [tenantDraft, setTenantDraft] = useState<Draft>(() => draftFrom(undefined));
  const [overriding, setOverriding] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [keyDecision, setKeyDecision] = useState<KeyDecision>({
    choice: "platform",
    recipients: [],
    ready: true,
  });
  // Held in this component and never sent back: the private key exists in this
  // response and nowhere else, so it must not survive a page reload either.

  useEffect(() => {
    if (clusterQuery.data) {
      const d = draftFrom(clusterQuery.data);
      // The cluster has nothing to inherit from.
      setClusterDraft({
        ...d,
        schedule: d.schedule.frequency === "inherit" ? { ...defaultSchedule, frequency: "off" } : d.schedule,
      });
    }
  }, [clusterQuery.data]);

  useEffect(() => {
    if (!tenantQuery.data) return;
    setTenantDraft(draftFrom(tenantQuery.data));
    setOverriding(tenantQuery.data.configured);
  }, [tenantQuery.data]);

  const settled = (message: string) => async () => {
    setError(null);
    setSuccess(message);
    setConfirmName("");
    await queryClient.invalidateQueries({ queryKey: ["admin", "backup-policy"] });
  };
  const failed = (err: Error) => {
    setSuccess(null);
    setError(err.message);
  };

  const saveCluster = useMutation({
    mutationFn: () =>
      saveClusterBackupPolicy({
        ...bodyFrom(clusterDraft, []),
        allowTenantOverride: clusterDraft.allowTenantOverride,
      }),
    onSuccess: settled(t("backupPolicy.clusterDefaultSaved")),
    onError: failed,
  });
  const saveTenant = useMutation({
    mutationFn: () => saveBackupPolicy(bodyFrom(tenantDraft, keyDecision.recipients, confirmName.trim()), tenant),
    onSuccess: settled(t("backupPolicy.backupSettingsSaved")),
    onError: failed,
  });
  const reset = useMutation({
    mutationFn: () => resetBackupPolicy(tenant),
    onSuccess: settled(t("backupPolicy.backToClusterSettings")),
    onError: failed,
  });

  const clusterPolicy = clusterQuery.data;
  const tenantPolicy = tenantQuery.data;
  const movingStorage = tenantDraft.storage === "external" && tenantDraft.endpoint.trim() !== "";
  const keyIncomplete = !keyDecision.ready;
  const overrideBlocked = clusterPolicy ? !clusterPolicy.allowTenantOverride : false;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("backupPolicy.backupSettings")}</h2>
          <p className="admin-console__lead">
            {t("backupPolicy.whereBackupsAreStoredWhen")}</p>
        </div>
      </header>

      {error && <p className="admin-console__error">{error}</p>}
      {success && <p className="admin-console__success">{success}</p>}

      {isPlatformAdmin && (
        <div className="admin-console__subsection">
          <h3 className="admin-console__subsection-title">{t("backupPolicy.clusterSettings")}</h3>
          <p className="admin-console__hint">
            {t("backupPolicy.theDefaultForEveryTenant")}</p>

          <StorageFields
            draft={clusterDraft}
            setDraft={setClusterDraft}
            platformLabel="This cluster's own storage"
          />

          <h4 className="admin-console__group-title">{t("backupPolicy.whenBackupsRun")}</h4>
          <ScheduleFields
            value={clusterDraft.schedule}
            onChange={(schedule) => setClusterDraft({ ...clusterDraft, schedule })}
            allowInherit={false}
            inherited=""
          />

          <h4 className="admin-console__group-title">{t("backupPolicy.howManyToKeep")}</h4>
          <RetentionFields
            value={clusterDraft.retention}
            onChange={(retention) => setClusterDraft({ ...clusterDraft, retention })}
          />

          <label className="admin-console__checkbox">
            <input
              type="checkbox"
              checked={clusterDraft.allowTenantOverride}
              onChange={(e) =>
                setClusterDraft({ ...clusterDraft, allowTenantOverride: e.target.checked })
              }
            />
            <span>
              {t("backupPolicy.tenantAdminsMayChooseTheir")}
              {t(
                clusterDraft.allowTenantOverride
                  ? "backupPolicy.overrideAllowedNote"
                  : "backupPolicy.overrideWithheldNote",
              )}
            </span>
          </label>

          <div className="admin-console__submit">
            <button
              type="button"
              className="admin-console__btn admin-console__btn--primary"
              disabled={saveCluster.isPending}
              onClick={() => saveCluster.mutate()}
            >
              {t(saveCluster.isPending ? "backupPolicy.saving" : "backupPolicy.saveDefault")}
            </button>
          </div>

          {clusterPolicy && <EffectiveSummary policy={clusterPolicy} />}
        </div>
      )}

      <div className="admin-console__subsection">
        <h3 className="admin-console__subsection-title">{titleCase(tenant)} {t("backupPolicy.settings")}</h3>

        {!overriding && (
          <>
            <p className="admin-console__hint">
              {tenantPolicy?.effectiveSchedule
                ? t("backupPolicy.backupsRun", {
                    schedule: tenantPolicy.effectiveSchedule,
                    where: tenantPolicy.effectiveEndpoint || t("backupPolicy.thePlatformsStorage"),
                  })
                : t("backupPolicy.noScheduledBackups")}
            </p>
            {overrideBlocked ? (
              <p className="admin-console__hint">
                {t("backupPolicy.yourProviderHasFixedThese")}</p>
            ) : (
              <button
                type="button"
                className="admin-console__btn"
                onClick={() => setOverriding(true)}
              >
                {t("backupPolicy.changeFor")}{tenant}
              </button>
            )}
          </>
        )}

        {overriding && (
          <>
            <h4 className="admin-console__group-title">{t("backupPolicy.whenBackupsRun2")}</h4>
            <ScheduleFields
              value={tenantDraft.schedule}
              onChange={(schedule) => setTenantDraft({ ...tenantDraft, schedule })}
              allowInherit
              inherited={clusterPolicy?.effectiveSchedule ?? ""}
            />

            <h4 className="admin-console__group-title">{t("backupPolicy.howManyToKeep2")}</h4>
            <RetentionFields
              value={tenantDraft.retention}
              onChange={(retention) => setTenantDraft({ ...tenantDraft, retention })}
            />

            {!overrideBlocked && (
              <>
                <h4 className="admin-console__group-title">{t("backupPolicy.whereBackupsAreStored2")}</h4>
                <StorageFields
                  draft={tenantDraft}
                  setDraft={setTenantDraft}
                  platformLabel="The platform's storage (recommended)"
                />
              </>
            )}

            <BackupKeyChoice
              tenant={tenant}
              idPrefix="backup-policy"
              choice={tenantDraft.keyChoice}
              onChoiceChange={(keyChoice) => setTenantDraft({ ...tenantDraft, keyChoice })}
              onDecision={(d) => setKeyDecision(d)}
            />

            {movingStorage && (
              <div className="admin-console__warning">
                <p>
                  {t("backupPolicy.backupsWillBeWrittenTo")}</p>
                <p>{t("backupPolicy.backupsAlreadyTakenStayWhere")}</p>
                <label className="admin-console__label">
                  <span className="admin-console__label-text">
                    <Trans
                      i18nKey="backupPolicy.typeToConfirm"
                      values={{ name: tenant }}
                      components={{ code: <code /> }}
                    />
                  </span>
                  <input
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    autoComplete="off"
                  />
                </label>
              </div>
            )}

            <div className="admin-console__submit">
              <button
                type="button"
                className="admin-console__btn admin-console__btn--primary"
                disabled={
                  saveTenant.isPending ||
                  keyIncomplete ||
                  (movingStorage && confirmName.trim() !== tenant)
                }
                onClick={() => saveTenant.mutate()}
              >
                {saveTenant.isPending ? "Saving…" : "Save"}
              </button>
              {tenantPolicy?.configured && (
                <button
                  type="button"
                  className="admin-console__btn admin-console__btn--danger"
                  disabled={reset.isPending}
                  onClick={() => {
                    if (window.confirm(t("backupPolicy.goBackConfirm"))) reset.mutate();
                  }}
                >
                  {t("backupPolicy.useTheClusterSettings")}</button>
              )}
            </div>
          </>
        )}

        {tenantPolicy && <EffectiveSummary policy={tenantPolicy} />}
      </div>
    </section>
  );
}
