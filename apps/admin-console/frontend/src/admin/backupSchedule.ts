/** Cron is the storage format; nobody should have to type it. */

export type Frequency = "inherit" | "off" | "daily" | "weekly" | "monthly" | "custom";

export type ScheduleForm = {
  frequency: Frequency;
  /** "HH:MM", UTC. */
  time: string;
  /** 0 = Sunday. */
  weekday: number;
  /** Capped at 28 so every month has the day. */
  monthday: number;
  custom: string;
};

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const defaultSchedule: ScheduleForm = {
  frequency: "inherit",
  time: "03:00",
  weekday: 0,
  monthday: 1,
  custom: "",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The cron expression a form describes, or "" for off and inherit. */
export function cronFrom(form: ScheduleForm): string {
  if (form.frequency === "off" || form.frequency === "inherit") return "";
  if (form.frequency === "custom") return form.custom.trim();

  const [hh, mm] = form.time.split(":");
  const hour = Number(hh) || 0;
  const minute = Number(mm) || 0;

  switch (form.frequency) {
    case "weekly":
      return `${minute} ${hour} * * ${form.weekday}`;
    case "monthly":
      return `${minute} ${hour} ${form.monthday} * *`;
    default:
      return `${minute} ${hour} * * *`;
  }
}

/**
 * Read a cron expression back into the form.
 *
 * Anything the simple controls cannot express falls through to custom, so a
 * hand-written expression survives a round trip through this screen.
 */
export function formFromCron(cron: string, suspended: boolean): ScheduleForm {
  if (suspended) return { ...defaultSchedule, frequency: "off" };
  const expr = cron.trim();
  if (!expr) return { ...defaultSchedule, frequency: "inherit" };

  const [min, hour, dom, month, dow] = expr.split(/\s+/);
  const numeric = (v: string) => /^\d+$/.test(v);
  const simpleTime = numeric(min) && numeric(hour) && month === "*";
  const time = simpleTime ? `${pad(Number(hour))}:${pad(Number(min))}` : defaultSchedule.time;

  if (simpleTime && dom === "*" && dow === "*") {
    return { ...defaultSchedule, frequency: "daily", time };
  }
  if (simpleTime && dom === "*" && numeric(dow) && Number(dow) <= 6) {
    return { ...defaultSchedule, frequency: "weekly", time, weekday: Number(dow) };
  }
  if (simpleTime && numeric(dom) && Number(dom) <= 28 && dow === "*") {
    return { ...defaultSchedule, frequency: "monthly", time, monthday: Number(dom) };
  }
  return { ...defaultSchedule, frequency: "custom", custom: expr };
}

/** One line of plain English for what a form will do. */
export function describeSchedule(form: ScheduleForm, inherited: string): string {
  switch (form.frequency) {
    case "inherit":
      return inherited
        ? `Follows the cluster setting: ${inherited} UTC.`
        : "Follows the cluster setting, which currently runs no scheduled backups.";
    case "off":
      return "No scheduled backups. You can still start one at any time.";
    case "daily":
      return `Every day at ${form.time} UTC.`;
    case "weekly":
      return `Every ${WEEKDAYS[form.weekday]} at ${form.time} UTC.`;
    case "monthly":
      return `On day ${form.monthday} of each month at ${form.time} UTC.`;
    default:
      return form.custom.trim()
        ? `Cron: ${form.custom.trim()} (UTC).`
        : "Enter a five-field cron expression.";
  }
}
