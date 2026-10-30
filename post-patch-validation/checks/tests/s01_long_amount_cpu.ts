/**
 * L4-S01 security (must pass on both revisions): rejecting an oversized
 * amount cell must cost bounded CPU. The CSV path has no cell-length cap
 * (parseAdjustmentCsv, the route and the parser add none) and Fastify's
 * default bodyLimit is 1 MiB, so a finance/super_admin upload can carry a
 * ~1,040,000-digit amount. The patched parser calls BigInt(wholePart) on the
 * whole digit run before its safe-range check (superlinear, synchronous, on
 * the event loop, inside the open import transaction). Invariant: the
 * cell is rejected and the median parse of it through the real
 * parseAdjustmentCsv -> parseAdjustmentAmountFils path takes < 250 ms.
 * Number(s) on the same string is timed as a machine calibration.
 */
import { parseAdjustmentAmountFils, parseAdjustmentCsv } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, diag, finish, run } from "./_lib.js";

const DIGITS = 1_040_000;
const LIMIT_MS = 250;
const RUNS = 5;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] as number;
}

function timeIt(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

run(() => {
  const failures: string[] = [];
  const cells = { "integer-digits": "9".repeat(DIGITS), "digits-with-3dp": `${"9".repeat(DIGITS)}.999` };
  const calibration = median(Array.from({ length: RUNS }, () => timeIt(() => void Number(cells["integer-digits"]))));
  diag(`calibration: Number() on ${DIGITS} digits median ${calibration.toFixed(1)} ms`);
  for (const [name, cell] of Object.entries(cells)) {
    const csv = `merchantId,amount,reason\n11111111-2222-4333-8444-555555555555,${cell},x\n`;
    diag(`${name}: CSV body ${Buffer.byteLength(csv)} bytes (Fastify default bodyLimit 1048576)`);
    let outcome = attempt(parseAdjustmentAmountFils, cell);
    const pathRun = (): void => {
      const rows = parseAdjustmentCsv(csv);
      outcome = attempt(parseAdjustmentAmountFils, rows[0]!.amount);
    };
    pathRun();
    const times = Array.from({ length: RUNS }, () => timeIt(pathRun));
    const m = median(times);
    diag(`${name}: ${outcome.ok ? `accepted ${outcome.value}` : `rejected (${outcome.code})`}; times ms ${times.map((t) => t.toFixed(1)).join(", ")}; median ${m.toFixed(1)}`);
    if (outcome.ok) failures.push(`${name}: a ${DIGITS}-digit amount was accepted`);
    if (m >= LIMIT_MS) failures.push(`${name}: rejecting a ${DIGITS}-digit amount took median ${m.toFixed(1)} ms (limit ${LIMIT_MS} ms; Number() calibration ${calibration.toFixed(1)} ms)`);
  }
  finish(failures);
});
