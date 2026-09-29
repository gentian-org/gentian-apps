import { useQuery } from "@tanstack/react-query";
import { fetchCustomizationDebtReport, type CustomizationRecord } from "@/api/admin";
import "./admin.css";
import { Trans, useTranslation } from "react-i18next";

const RUNGS = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as const;

/** L4 and above are carried deltas — the rungs the headline number tracks. */
const CARRIED_FROM = 4;

/**
 * The customization debt report — see gentian-os/docs/app-customization.md §8.3.
 *
 * Reads live Customization CRs. The headline number is "carried deltas" (records
 * at L4 or above): that count is the one meant to trend down over time, the same
 * way ServiceNow and SAP shops track customization debt after the fact — this
 * lets Gentian see it before it accumulates.
 */
export function CustomizationDebtSection() {
  const { t } = useTranslation();

  const reportQuery = useQuery({
    queryKey: ["admin", "platform", "customization-debt"],
    queryFn: () => fetchCustomizationDebtReport(),
  });

  if (reportQuery.isLoading) {
    return <p className="admin-console__loading">{t("customizationDebt.loadingCustomizationDebtReport")}</p>;
  }
  if (reportQuery.isError || !reportQuery.data) {
    return (
      <p className="admin-console__error">{t("customizationDebt.customizationDebtReportIsUnavailable")}</p>
    );
  }

  const report = reportQuery.data;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">{t("customizationDebt.customizationDebt")}</h2>
          <p className="admin-console__lead">
            <Trans
              i18nKey="customizationDebt.lead"
              components={{
                code: <code />,
                ladder: (
                  <a
                    href="https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md"
                    target="_blank"
                    rel="noreferrer"
                  />
                ),
              }}
            />
          </p>
        </div>
      </header>

      <div className="admin-console__stats">
        <div className="admin-console__stat">
          <div className="admin-console__stat-value">{report.totalRecords}</div>
          <div className="admin-console__stat-label">
            {t("customizationDebt.trackedRecord")}{report.totalRecords === 1 ? "" : "s"}
          </div>
        </div>
        {/* The one number meant to trend down — the only tile that raises its
            voice, so a wall of flagged rungs cannot drown it out. */}
        <div
          className={`admin-console__stat${
            report.carriedDeltas > 0
              ? " admin-console__stat--alert"
              : " admin-console__stat--accent"
          }`}
        >
          <div className="admin-console__stat-value">{report.carriedDeltas}</div>
          <div className="admin-console__stat-label">{t("customizationDebt.carriedDeltaAtL4")}</div>
        </div>
      </div>

      <h3 className="admin-console__subsection-title">{t("customizationDebt.recordsByRung")}</h3>
      <div className="admin-console__stats admin-console__stats--strip">
        {RUNGS.map((rung, index) => (
          <div
            key={rung}
            className={`admin-console__stat${
              index >= CARRIED_FROM ? " admin-console__stat--accent" : ""
            }`}
          >
            <div className="admin-console__stat-value">{report.byRung[rung]}</div>
            <div className="admin-console__stat-label">{rung}</div>
          </div>
        ))}
      </div>

      <RecordList
        title={t("customizationDebt.pastReviewDate")}
        empty="Nothing is overdue for review."
        records={report.reviewOverdue}
      />
      <RecordList
        title={t("customizationDebt.upstreamFirstObligationUnmetOr")}
        empty="Every carried delta has a recorded upstream outcome."
        records={report.upstreamStale}
      />
      <RecordList
        title={t("customizationDebt.aCheaperRungIsNow")}
        empty="No record could currently descend to a cheaper rung."
        records={report.rungAboveRecommended}
      />
    </section>
  );
}

function RecordList({
  title,
  empty,
  records,
}: {
  title: string;
  empty: string;
  records: CustomizationRecord[];
}) {
  const { t } = useTranslation();

  return (
    <div className="admin-console__subsection">
      <h3 className="admin-console__subsection-title">
        {title}
        {records.length > 0 ? (
          <span className="admin-console__badge admin-console__badge--warn">
            {records.length}
          </span>
        ) : null}
      </h3>

      {records.length === 0 ? (
        <p className="admin-console__empty">{empty}</p>
      ) : (
        <div className="admin-console__table-wrap">
          <table className="admin-console__table">
            <thead>
              <tr>
                <th>{t("customizationDebt.record")}</th>
                <th>{t("customizationDebt.target")}</th>
                <th>{t("customizationDebt.rung")}</th>
                <th>{t("customizationDebt.scope")}</th>
                <th>{t("customizationDebt.owner")}</th>
                <th>{t("customizationDebt.reviewBy")}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={`${record.namespace}/${record.name}`}>
                  <td>{record.summary || record.name}</td>
                  <td>
                    <code>{record.targetProfile}</code>
                  </td>
                  <td>
                    <code>{record.rung}</code>
                  </td>
                  <td>{record.scope}</td>
                  <td>{record.owner}</td>
                  <td>{record.reviewBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
