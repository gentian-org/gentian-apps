import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchGroups,
  fetchNotifications,
  publishNotification,
  type AdminGroup,
  type NotificationSeverity,
} from "@/api/admin";
import "./admin.css";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

type NotificationsSectionProps = {
  tenant: string;
  isPlatformAdmin: boolean;
};

const SEVERITY_OPTIONS: Array<{ value: NotificationSeverity; label: string }> = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

function formatPublishedAt(epochMs: number) {
  if (!epochMs) {
    return "—";
  }
  return new Date(epochMs).toLocaleString();
}

function audienceLabel(
  audience: { scope: string; tenant?: string | null; groups: string[] },
  t: TFunction,
) {
  if (audience.scope === "platform") {
    return t("notifications.platformAllUsers");
  }
  if (audience.groups.length === 1) {
    return audience.groups[0];
  }
  if (audience.groups.length > 1) {
    return `${audience.groups.length} groups`;
  }
  return `Tenant ${audience.tenant ?? "members"}`;
}

export function NotificationsSection({ tenant, isPlatformAdmin }: NotificationsSectionProps) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<NotificationSeverity>("info");
  const [scope, setScope] = useState<"tenant" | "platform">("tenant");
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const groupsQuery = useQuery({
    queryKey: ["admin", "groups", tenant],
    queryFn: () => fetchGroups(tenant),
  });

  const notificationsQuery = useQuery({
    queryKey: ["admin", "notifications", tenant],
    queryFn: () => fetchNotifications(tenant),
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      publishNotification(
        {
          title,
          body,
          severity,
          audience: {
            scope,
            tenant: scope === "tenant" ? tenant : undefined,
            groups: scope === "tenant" ? selectedGroups : [],
          },
          linkUrl: linkUrl || undefined,
          linkLabel: linkLabel || undefined,
        },
        tenant,
      ),
    onSuccess: async () => {
      setError(null);
      setSuccess(t("notifications.published"));
      setTitle("");
      setBody("");
      setLinkUrl("");
      setLinkLabel("");
      setSelectedGroups([]);
      await queryClient.invalidateQueries({ queryKey: ["admin", "notifications", tenant] });
      await queryClient.invalidateQueries({ queryKey: ["notifications", "inbox"] });
    },
    onError: (err: Error) => {
      setSuccess(null);
      setError(err.message);
    },
  });

  const groups = groupsQuery.data ?? [];
  const notifications = notificationsQuery.data ?? [];

  const toggleGroup = (group: AdminGroup) => {
    setSelectedGroups((current) =>
      current.includes(group.name)
        ? current.filter((name) => name !== group.name)
        : [...current, group.name],
    );
  };

  return (
    <section>
      <div className="admin-console__toolbar">
        <h2 className="admin-console__section-title">
          {t("notifications.notifications")}</h2>
        <button
          type="button"
          className="admin-console__btn"
          onClick={() => notificationsQuery.refetch()}
        >
          {t("notifications.refresh")}</button>
      </div>

      <p className="admin-console__hint" style={{ marginBottom: "1rem" }}>
        {t("notifications.publishScopedBroadcastsToWorkspace")}</p>

      {error && <p className="admin-console__error">{error}</p>}
      {success && <p className="admin-console__success">{success}</p>}

      <form
        className="admin-console__form"
        onSubmit={(event) => {
          event.preventDefault();
          publishMutation.mutate();
        }}
      >
        <label className="admin-console__field">
          <span>{t("notifications.title")}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={512}
          />
        </label>

        <label className="admin-console__field">
          <span>{t("notifications.message")}</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            maxLength={4000}
            rows={4}
          />
        </label>

        <div className="admin-console__field-row">
          <label className="admin-console__field">
            <span>{t("notifications.severity")}</span>
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value as NotificationSeverity)}
            >
              {SEVERITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="admin-console__field">
            <span>{t("notifications.audience")}</span>
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value as "tenant" | "platform")}
            >
              <option value="tenant">{t("notifications.tenantGroups")}</option>
              {isPlatformAdmin && <option value="platform">{t("notifications.platformAllUsers")}</option>}
            </select>
          </label>
        </div>

        {scope === "tenant" && (
          <fieldset className="admin-console__fieldset">
            <legend>{t("notifications.targetGroupsEmptyAllTenant")}</legend>
            <div className="admin-console__checkbox-grid">
              {groups.map((group) => (
                <label key={group.id} className="admin-console__checkbox">
                  <input
                    type="checkbox"
                    checked={selectedGroups.includes(group.name)}
                    onChange={() => toggleGroup(group)}
                  />
                  <span>{group.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="admin-console__field-row">
          <label className="admin-console__field">
            <span>{t("notifications.linkUrlOptional")}</span>
            <input value={linkUrl} onChange={(event) => setLinkUrl(event.target.value)} />
          </label>
          <label className="admin-console__field">
            <span>{t("notifications.linkLabelOptional")}</span>
            <input value={linkLabel} onChange={(event) => setLinkLabel(event.target.value)} />
          </label>
        </div>

        <button
          type="submit"
          className="admin-console__btn admin-console__btn--primary"
          disabled={publishMutation.isPending || !title.trim() || !body.trim()}
        >
          {publishMutation.isPending ? "Publishing…" : t("notifications.publishNotification")}
        </button>
      </form>

      <h3 className="admin-console__subtitle" style={{ marginTop: "2rem" }}>
        {t("notifications.published")}</h3>
      {notifications.length === 0 ? (
        <p className="admin-console__hint">{t("notifications.noNotificationsPublishedForThis")}</p>
      ) : (
        <table className="admin-console__table">
          <thead>
            <tr>
              <th>{t("notifications.published2")}</th>
              <th>{t("notifications.title2")}</th>
              <th>{t("notifications.severity2")}</th>
              <th>{t("notifications.audience2")}</th>
              <th>{t("notifications.publisher")}</th>
            </tr>
          </thead>
          <tbody>
            {notifications.map((notification) => (
              <tr key={notification.id}>
                <td>{formatPublishedAt(notification.publishedAt)}</td>
                <td>
                  <strong>{notification.title}</strong>
                  <div className="admin-console__mono" style={{ marginTop: "0.25rem" }}>
                    {notification.body}
                  </div>
                </td>
                <td>{notification.severity}</td>
                <td>{audienceLabel(notification.audience, t)}</td>
                <td>{notification.publisher}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
