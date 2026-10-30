/**
 * Shared helpers for the L4 validation scripts. Copied by ppv.mjs into
 * <tree>/apps/api/__ppv__/ next to every check script, so "../src/..." is the
 * revision under test.
 *
 * Output discipline: stdout carries only what a check deliberately prints
 * (canonical observations, the PPV_REACHED marker). Diagnostics go to stderr.
 */
import fs from "node:fs";

export const MARKER = "PPV_REACHED";

/**
 * The check's stdout. ppv.mjs hands it to the script as fd 3 (L4_OUT_FD) and
 * sends the script's own fd 1 to stderr, because the app under test logs
 * timestamped JSON to fd 1.
 */
const OUT_FD = Number.parseInt(process.env.L4_OUT_FD ?? "1", 10);

/** Writes one line to the check's stdout synchronously (no buffering, survives exit). */
export function out(line: string): void {
  fs.writeSync(OUT_FD, `${line}\n`);
}

/** Writes one line to stderr synchronously. */
export function diag(line: string): void {
  fs.writeSync(2, `${line}\n`);
}

/** Prints the reached marker on its own stdout line, flushed. */
export function reached(): void {
  fs.writeSync(OUT_FD, `${MARKER}\n`);
}

export type Outcome =
  | { ok: true; value: number }
  | { ok: false; ctor: string; name: string; statusCode: unknown; code: unknown; message: string };

/** Calls fn(input) and records either its numeric result or the thrown error's shape. */
export function attempt(fn: (raw: string) => number, input: string): Outcome {
  try {
    return { ok: true, value: fn(input) };
  } catch (err) {
    const e = err as { constructor?: { name?: string }; name?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
    return {
      ok: false,
      ctor: String(e?.constructor?.name ?? typeof err),
      name: String(e?.name ?? ""),
      statusCode: e?.statusCode ?? null,
      code: e?.code ?? null,
      message: String(e?.message ?? err),
    };
  }
}

/** Renders an outcome for evidence logs; -0 is shown explicitly. */
export function showOutcome(o: Outcome): string {
  if (o.ok) return Object.is(o.value, -0) ? "-0" : String(o.value);
  return `rejected(${o.ctor}/${String(o.code)})`;
}

/** JSON with recursively sorted object keys, so output is byte-stable. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((k) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

/** Exits 1 listing failures, or 0. */
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

/** Deterministic 32-bit PRNG (mulberry32). */
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

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const STRICT_BHD = /^(-?)(\d+)(?:\.(\d{1,3}))?$/;

/**
 * Independent ADR-0001 oracle (does not call parseBhdToFils): after
 * String.prototype.trim, accept iff the text is an optional '-', ASCII digits,
 * and at most three ASCII fraction digits, and |value| <= MAX_SAFE_INTEGER
 * fils; the value is int*1000 + fraction padded to three digits, signed.
 * Returns null for "must be rejected".
 */
export function adrOracle(input: string): number | null {
  const m = STRICT_BHD.exec(input.trim());
  if (!m) return null;
  const magnitude = BigInt(m[2] as string) * 1000n + BigInt((m[3] ?? "").padEnd(3, "0"));
  if (magnitude > MAX_SAFE) return null;
  const n = Number(magnitude);
  return m[1] === "-" && n !== 0 ? -n : n;
}

/** Canonical "D.DDD" rendering of an accepted input, computed from the oracle value. */
export function canonicalBhd(fils: number): string {
  const neg = fils < 0;
  const abs = BigInt(Math.abs(fils));
  return `${neg ? "-" : ""}${abs / 1000n}.${String(abs % 1000n).padStart(3, "0")}`;
}

/** Greatest common divisor for BigInt, used to print exact ratios. */
export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/** Exact ratio a/b in lowest terms, e.g. "19/4"; sign carried on the numerator. */
export function ratio(a: number, b: number): string {
  const A = BigInt(a);
  const B = BigInt(b);
  if (B === 0n) return "undefined";
  if (A === 0n) return "0";
  const g = gcd(A, B);
  let n = A / g;
  let d = B / g;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  return d === 1n ? `${n}` : `${n}/${d}`;
}

export interface TapTest {
  file: string | null;
  name: string;
  ok: boolean;
  /** Raw YAML diagnostic block lines of a failing test (actual/expected/error). */
  diagnostics: string[];
}

export interface ProjectTestRun {
  code: number | null;
  signal: string | null;
  tap: string;
  tests: TapTest[];
  summary: Record<string, number>;
}

/**
 * Runs the project's own node:test runner through tsx, exactly as its npm
 * scripts do (`tsx --test --test-concurrency=1 <files>`), with the TAP
 * reporter, from `cwd`. The child's output is mirrored to stderr and parsed.
 */
export async function runProjectTests(
  cwd: string,
  files: string[],
  extraEnv: Record<string, string> = {},
): Promise<ProjectTestRun> {
  const { spawn } = await import("node:child_process");
  const tsxCli = process.env.L4_TSX_CLI;
  if (!tsxCli) throw new Error("L4_TSX_CLI is not set; run through ppv.mjs");
  const args = [tsxCli, "--no-cache", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files];
  diag(`running: node ${args.join(" ")} (cwd ${cwd})`);
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...extraEnv, L4_OUT_FD: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => {
    chunks.push(c);
    fs.writeSync(2, c);
  });
  child.stderr.on("data", (c: Buffer) => fs.writeSync(2, c));
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
    child.on("close", (c, s) => resolve([c, s])),
  );
  const tap = Buffer.concat(chunks).toString("utf8");
  return { code, signal, tap, ...parseTap(tap) };
}

/**
 * Minimal TAP parser for node:test output: every `ok`/`not ok` line at any
 * depth is a test; a `# Subtest: <file path>` at depth 0 sets the file.
 * Depth-0 tests whose name is a file path are file wrappers and are skipped.
 */
export function parseTap(tap: string): { tests: TapTest[]; summary: Record<string, number> } {
  const lines = tap.split(/\r?\n/);
  const tests: TapTest[] = [];
  const summary: Record<string, number> = {};
  let file: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const sub = /^# Subtest: (.*)$/.exec(line);
    if (sub && /\.test\.ts$/.test(sub[1] as string)) file = sub[1] as string;
    const sum = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (sum) summary[sum[1] as string] = Number(sum[2]);
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s+(SKIP|TODO).*)?$/.exec(line);
    if (!m) continue;
    const name = m[3] as string;
    if ((m[1] as string).length === 0 && /\.test\.ts$/.test(name)) continue;
    const diagnostics: string[] = [];
    if (m[2] === "not ok") {
      const indent = (m[1] as string).length;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] as string;
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() === "") continue;
        if (nextIndent <= indent && !next.trimStart().startsWith("---") && !next.trimStart().startsWith("...")) break;
        diagnostics.push(next);
        if (next.trim() === "...") break;
      }
    }
    tests.push({ file, name, ok: m[2] === "ok", diagnostics });
  }
  return { tests, summary };
}

export type Exact =
  | { kind: "integer"; value: bigint }
  | { kind: "fractional" }
  | { kind: "unsafe" }
  | { kind: "nonnumeric" };

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * The exact fils value of a BD amount text under ADR-0001 (1 BD = 1000 fils),
 * computed with BigInt only (never parseBhdToFils). After String.prototype.trim
 * (which both revisions apply), a plain ASCII decimal maps to
 * value * 1000; it is "fractional" when that is not a whole number of fils
 * (e.g. 4.7555 BD), "unsafe" when it exceeds Number.MAX_SAFE_INTEGER, and
 * "nonnumeric" when the text is not a plain decimal at all.
 */
export function exactFils(input: string): Exact {
  const m = PLAIN_DECIMAL.exec(input.trim());
  if (!m) return { kind: "nonnumeric" };
  const frac = m[3] ?? "";
  const scale = 10n ** BigInt(frac.length);
  const numerator = (BigInt(m[2] as string) * scale + BigInt(frac === "" ? "0" : frac)) * 1000n;
  if (numerator % scale !== 0n) return { kind: "fractional" };
  const magnitude = numerator / scale;
  if (magnitude > MAX_SAFE) return { kind: "unsafe" };
  return { kind: "integer", value: m[1] === "-" ? -magnitude : magnitude };
}

/**
 * The security invariant of finding L4 for one input: the parser either
 * rejects the text, or returns exactly its ADR-0001 fils value. Returns null
 * when the outcome satisfies it, otherwise a description of the violation.
 */
export function exactOrRejectViolation(input: string, o: Outcome): string | null {
  if (!o.ok) return null;
  const e = exactFils(input);
  if (e.kind !== "integer") return `${JSON.stringify(input)} is ${e.kind} under ADR-0001 but was accepted as ${showOutcome(o)}`;
  if (!Number.isSafeInteger(o.value) || BigInt(o.value) !== e.value) {
    return `${JSON.stringify(input)} must be ${e.value} fils (ADR-0001) or rejected, got ${showOutcome(o)}`;
  }
  return null;
}

export interface CorpusCase {
  input: string;
  bucket: string;
}

/**
 * Deterministic, seeded amount-text corpus (mulberry32). Grammar: optional
 * pad, optional sign ('', '-', '+', '--'), 0-16 integer digits (leading
 * zeros allowed), optional '.' with 0-5 fraction digits, optional junk
 * suffix. Each case is labelled with its ADR-0001 bucket.
 */
export function amountCorpus(seed: number, n: number): CorpusCase[] {
  const rnd = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)] as T;
  const digits = (count: number): string => Array.from({ length: count }, () => String(Math.floor(rnd() * 10))).join("");
  const cases: CorpusCase[] = [];
  for (let i = 0; i < n; i++) {
    const pad = rnd() < 0.8 ? "" : pick([" ", "\t", " ", "﻿"]);
    const r = rnd();
    const sign = r < 0.62 ? "" : r < 0.92 ? "-" : r < 0.96 ? "+" : "--";
    const intLen = rnd() < 0.03 ? 0 : 1 + Math.floor(rnd() * 16);
    const lead = intLen > 1 && rnd() < 0.1 ? "0".repeat(1 + Math.floor(rnd() * 3)) : "";
    const intPart = lead + digits(intLen);
    const f = rnd();
    const frac = f < 0.22 ? "" : f < 0.27 ? "." : `.${digits(1 + Math.floor(rnd() * 5))}`;
    const junk = rnd() < 0.9 ? "" : pick(["e3", "BD", ",", "x", ".", "abc"]);
    const input = `${pad}${sign}${intPart}${frac}${junk}${pad}`;
    cases.push({ input, bucket: bucketOf(input) });
  }
  return cases;
}

/** ADR-0001 bucket of an input: accepted-0dp/1-2dp/3dp, over-3dp, unsafe, or junk. */
export function bucketOf(input: string): string {
  const e = exactFils(input);
  if (e.kind === "nonnumeric") return "junk";
  if (e.kind === "unsafe") return "unsafe";
  const m = PLAIN_DECIMAL.exec(input.trim()) as RegExpExecArray;
  const fl = (m[3] ?? "").length;
  if (fl > 3) return e.kind === "fractional" ? "over3dp-fractional" : "over3dp-trailing-zeros";
  return fl === 0 ? "valid-0dp" : fl <= 2 ? "valid-1to2dp" : "valid-3dp";
}

/** Fixed edge inputs appended to every generated corpus. */
export const EDGE_INPUTS: readonly string[] = [
  "0", "-0", "0.000", "-0.000", "0.001", "-0.001", "0.0001", "-0.0001", "0.005", "-0.005",
  "4.75", "4.750", "4.755", "4.7555", "4.7500", "120.00", "120.0000", "-3.50", "0004.750", " 4.75 ",
  "999999999999.999", "-999999999999.999", "9007199254740.991", "9007199254740.992",
  "-9007199254740.991", "-9007199254740.992", "90071992547409.91", "90071992547409.92",
  ".5", "5.", "1e3", "+1", "+4.75", "٤.٧٥", "４.７５", "4,750", "", "-", "4.75abc", "0x10", "Infinity", "NaN",
];

/** Rejects after `ms` milliseconds with a labelled timeout error. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
