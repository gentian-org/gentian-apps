import { useQuery } from "@tanstack/react-query";
import { fetchCustomizationDebtReport, type CustomizationRecord } from "@/api/admin";
import "./admin.css";

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
  const reportQuery = useQuery({
    queryKey: ["admin", "platform", "customization-debt"],
    queryFn: () => fetchCustomizationDebtReport(),
  });

  if (reportQuery.isLoading) {
    return <p className="admin-console__loading">Loading customization debt report…</p>;
  }
  if (reportQuery.isError || !reportQuery.data) {
    return (
      <p className="admin-console__error">Customization debt report is unavailable.</p>
    );
  }

  const report = reportQuery.data;

  return (
    <section>
      <header className="admin-console__section-head">
        <div>
          <h2 className="admin-console__section-title">Customization debt</h2>
          <p className="admin-console__lead">
            Every deviation from an app as shipped, tracked as a <code>Customization</code>{" "}
            record. Lower rungs (L0–L1) are routine; rungs L4 and above are carried deltas that
            must be reviewed, forwarded upstream, and eventually dropped. See the{" "}
            <a
              href="https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md"
              target="_blank"
              rel="noreferrer"
            >
              customization ladder
            </a>
            .
          </p>
        </div>
      </header>

      <div className="admin-console__stats">
        <div className="admin-console__stat">
          <div className="admin-console__stat-value">{report.totalRecords}</div>
          <div className="admin-console__stat-label">
            Tracked record{report.totalRecords === 1 ? "" : "s"}
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
          <div className="admin-console__stat-label">Carried delta at L4+</div>
        </div>
      </div>

      <h3 className="admin-console__subsection-title">Records by rung</h3>
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
        title="Past review date"
        empty="Nothing is overdue for review."
        records={report.reviewOverdue}
      />
      <RecordList
        title="Upstream-first obligation unmet or superseded"
        empty="Every carried delta has a recorded upstream outcome."
        records={report.upstreamStale}
      />
      <RecordList
        title="A cheaper rung is now available"
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
                <th>Record</th>
                <th>Target</th>
                <th>Rung</th>
                <th>Scope</th>
                <th>Owner</th>
                <th>Review by</th>
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
