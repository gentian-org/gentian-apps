export type QuotaResource = {
  name: string;
  label: string;
  unit: "cores" | "bytes" | "count" | string;
  used: string;
  hard: string;
  usedValue: number;
  hardValue: number;
  percent: number;
};

export type QuotaResponse = {
  present: boolean;
  resources: QuotaResource[];
};

const GIB = 1024 ** 3;

/** Round to at most `places`, without trailing zeroes: 3.95, 6, 0.5. */
function trim(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

/**
 * The quantities the API server enforces are not the quantities people read.
 * "3950m" and "3758096384" are exact and unhelpful; the ceiling they are
 * measured against is what the reader is deciding about, so both sides are
 * shown in one unit.
 */
function format(value: number, unit: string): string {
  if (unit === "bytes") return `${trim(value / GIB, 1)} GiB`;
  if (unit === "cores") return trim(value, 2);
  return trim(value, 0);
}

/**
 * Colour carries the same judgement as the number, for readers who scan
 * rather than read. The thresholds are deliberately pessimistic: an app is
 * refused when it does not fit, not when the bar reaches the end, so "nearly
 * full" has to arrive before full.
 */
function tone(percent: number): { bar: string; text: string } {
  if (percent >= 90) return { bar: "bg-rose-500", text: "text-rose-700" };
  if (percent >= 75) return { bar: "bg-amber-500", text: "text-amber-700" };
  return { bar: "bg-emerald-500", text: "text-emerald-700" };
}

export function TenantQuotaBar({ quota }: { quota: QuotaResponse | null }) {
  // Absent while the first fetch is in flight, and on a cluster that sets no
  // quota at all. Neither is "full", and neither is worth a placeholder.
  if (!quota || !quota.present || quota.resources.length === 0) return null;

  return (
    <section
      aria-label="Tenant resources"
      className="mb-6 rounded-lg border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Tenant resources</h2>
        <p className="text-xs text-slate-500">
          What this tenant may use in total, and what its installed apps already take.
        </p>
      </div>

      <dl className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {quota.resources.map((resource) => {
          const colour = tone(resource.percent);
          return (
            <div key={resource.name}>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-xs font-medium text-slate-700">{resource.label}</dt>
                <dd className={`text-xs font-medium ${colour.text}`}>{resource.percent}%</dd>
              </div>
              <div
                className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                role="progressbar"
                aria-valuenow={resource.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${resource.label} used`}
              >
                <div
                  className={`h-full rounded-full ${colour.bar}`}
                  style={{ width: `${Math.max(resource.percent, 1)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {format(resource.usedValue, resource.unit)} of{" "}
                {format(resource.hardValue, resource.unit)}
                {resource.unit === "cores" ? " cores" : ""} used
              </p>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
