/**
 * Kubernetes quantity parsing and display.
 *
 * The resources API returns quantities as Kubernetes writes them — "32",
 * "48Gi", "3100m" — because that is what the cluster enforces and what a
 * tenant.yaml contains. Turning them into numbers is the console's job, and
 * doing it wrong is not a cosmetic error: a chart that reads 48Gi as 48 draws
 * a tenant at four billion percent of its ceiling.
 */

/** Binary suffixes: 1Gi is 2^30, not 10^9. */
const BINARY: Record<string, number> = {
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
};

/** Decimal suffixes, including the fractional ones CPU uses. */
const DECIMAL: Record<string, number> = {
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const QUANTITY = /^([+-]?\d+(?:\.\d+)?)([a-zA-Z]*)$/;

/** Parse a Kubernetes quantity, or NaN when it is not one. */
export function parseQuantity(value: string | undefined | null): number {
  if (!value) {
    return Number.NaN;
  }
  const match = QUANTITY.exec(value.trim());
  if (!match) {
    return Number.NaN;
  }
  const amount = Number(match[1]);
  const suffix = match[2];
  if (suffix in BINARY) {
    return amount * BINARY[suffix];
  }
  if (suffix in DECIMAL) {
    return amount * DECIMAL[suffix];
  }
  return Number.NaN;
}

export type QuantityKind = "cpu" | "bytes" | "count";

/**
 * What a ResourceQuota key measures.
 *
 * Derived from the key rather than configured, because the keys are
 * Kubernetes's and fixed: limits.cpu, limits.memory, requests.storage, pods.
 */
export function quantityKind(resource: string): QuantityKind {
  if (resource.includes("cpu")) {
    return "cpu";
  }
  if (resource.includes("memory") || resource.includes("storage")) {
    return "bytes";
  }
  return "count";
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Render a parsed number back into something a person reads. */
export function formatQuantity(value: number, kind: QuantityKind): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (kind === "bytes") {
    let scaled = value;
    let unit = 0;
    while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    return `${trim(scaled)} ${BYTE_UNITS[unit]}`;
  }
  if (kind === "cpu") {
    // Below one core, milliCPU is the unit every Kubernetes surface uses;
    // "0.15 cores" would be the only place in the cluster saying it that way.
    if (value > 0 && value < 1) {
      return `${Math.round(value * 1000)}m`;
    }
    return `${trim(value)} ${value === 1 ? "core" : "cores"}`;
  }
  return trim(value);
}

function trim(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "");
}

/** A short label for a ResourceQuota key, for axes and table headers. */
export function resourceLabel(resource: string): string {
  switch (resource) {
    // Requests first in the reader's mind as well as the table: reserved
    // capacity is what a plan sells, and the limits rows beside it are a burst
    // ceiling that will always look far from full.
    case "requests.cpu":
      return "CPU reserved";
    case "requests.memory":
      return "Memory reserved";
    case "limits.cpu":
      return "CPU burst ceiling";
    case "limits.memory":
      return "Memory burst ceiling";
    case "requests.storage":
      return "Storage";
    case "pods":
      return "Pods";
    default:
      return resource;
  }
}
