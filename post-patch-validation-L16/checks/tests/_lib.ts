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

// ------------------------------------------------------------ project test runner

export interface TapTest {
  name: string;
  ok: boolean;
  /** Raw YAML diagnostic lines of a failing test. */
  diagnostics: string[];
}

export interface ProjectTestRun {
  code: number | null;
  signal: string | null;
  tests: TapTest[];
  summary: Record<string, number>;
}

/**
 * Runs the project's own node:test runner through tsx, exactly as
 * apps/api's `npm test` does (`tsx --test --test-concurrency=1 <files>`),
 * with the TAP reporter, from `cwd`. The child's output is mirrored to stderr.
 */
export async function runProjectTests(cwd: string, files: string[]): Promise<ProjectTestRun> {
  const { spawn } = await import("node:child_process");
  const tsxCli = process.env.L16_TSX_CLI;
  if (!tsxCli) throw new Error("L16_TSX_CLI is not set; run through ppv.mjs");
  const args = [tsxCli, "--no-cache", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files];
  diag(`running: node ${args.join(" ")} (cwd ${cwd})`);
  const env = { ...process.env };
  delete env.L16_OUT_FD;
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => {
    chunks.push(c);
    fs.writeSync(2, c);
  });
  child.stderr.on("data", (c: Buffer) => fs.writeSync(2, c));
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) =>
    child.on("close", (c, s) => resolve([c, s])),
  );
  return { code, signal, ...parseTap(Buffer.concat(chunks).toString("utf8")) };
}

/** Minimal TAP parser for node:test output; depth-0 file wrappers are skipped. */
export function parseTap(tap: string): { tests: TapTest[]; summary: Record<string, number> } {
  const lines = tap.split(/\r?\n/);
  const tests: TapTest[] = [];
  const summary: Record<string, number> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const sum = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (sum) summary[sum[1] as string] = Number(sum[2]);
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s+(SKIP|TODO).*)?$/.exec(line);
    if (!m) continue;
    const name = m[3] as string;
    if ((m[1] as string).length === 0 && /\.test\.ts$/.test(name)) continue;
    const diagnostics: string[] = [];
    if (m[2] === "not ok") {
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        const next = lines[j] as string;
        diagnostics.push(next);
        if (next.trim() === "...") break;
      }
    }
    tests.push({ name, ok: m[2] === "ok", diagnostics });
  }
  return { tests, summary };
}
