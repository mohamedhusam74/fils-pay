/**
 * Output and control-flow helpers for the L16 validation scripts. Copied by
 * ppv.mjs into <tree>/apps/api/__ppv__/, so "../src/..." is the revision
 * under test.
 *
 * Output discipline: the check's stdout carries only what a script prints on
 * purpose (canonical observations and the PPV_REACHED marker). The app under
 * test logs JSON to fd 1, which ppv.mjs routes to stderr; deliberate output
 * goes to fd 3 (L16_OUT_FD), which is the check's stdout.
 */
import fs from "node:fs";

export const MARKER = "PPV_REACHED";

const OUT_FD = Number.parseInt(process.env.L16_OUT_FD ?? "1", 10);

/** One line to the check's stdout, written synchronously. */
export function out(line: string): void {
  fs.writeSync(OUT_FD, `${line}\n`);
}

/** One line to stderr, written synchronously. */
export function diag(line: string): void {
  fs.writeSync(2, `${line}\n`);
}

/** The reached marker on its own stdout line, written synchronously. */
export function reached(): void {
  fs.writeSync(OUT_FD, `${MARKER}\n`);
}

/** JSON with recursively sorted object keys, so output is byte-stable. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

/** Exits 1 listing failures on stderr, or 0. */
export function finish(failures: string[]): never {
  if (failures.length > 0) {
    diag(`ASSERTION FAILED (${failures.length}):`);
    for (const f of failures) diag(`  - ${f}`);
    process.exit(1);
  }
  diag("all assertions passed");
  process.exit(0);
}

/** Runs an async main; an unexpected throw is a harness error (exit 2), not an assertion failure. */
export function run(main: () => Promise<void> | void): void {
  Promise.resolve()
    .then(main)
    .catch((err: unknown) => {
      diag(`HARNESS ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exit(2);
    });
}

/** Deterministic 32-bit PRNG (mulberry32), for the schedule fuzzer. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
