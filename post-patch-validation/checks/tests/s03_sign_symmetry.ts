/**
 * L4-S03 security (must pass on both revisions): money direction depends on
 * the sign of the parsed amount (postLedgerAdjustment credits
 * merchant_payable for > 0; the cache adds the signed value). The patch
 * replaced toFils(..., {allowNegative: true}) with sign-derived negativity
 * in parseBhdToFils, so a dropped sign would turn a debit into a credit.
 * For seeded s matching \d{1,12}(\.\d{1,3})? (valid on both revisions):
 * parse(s) >= 0, parse("-" + s) <= 0 and parse(s) + parse("-" + s) === 0
 * (arithmetic, so base's -0 and the patch's +0 are both fine).
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, diag, finish, mulberry32, run } from "./_lib.js";

run(() => {
  const rnd = mulberry32(0x4c340004);
  const digits = (n: number): string => Array.from({ length: n }, () => String(Math.floor(rnd() * 10))).join("");
  const inputs = ["0", "0.000", "0.001", "0.005", "4.75", "4.755", "999999999999.999", "1", "0.01"];
  for (let i = 0; i < 5000; i++) {
    const frac = rnd() < 0.25 ? "" : `.${digits(1 + Math.floor(rnd() * 3))}`;
    inputs.push(`${digits(1 + Math.floor(rnd() * 12))}${frac}`);
  }
  const failures: string[] = [];
  for (const s of inputs) {
    const p = attempt(parseAdjustmentAmountFils, s);
    const n = attempt(parseAdjustmentAmountFils, `-${s}`);
    if (!p.ok || !n.ok) {
      failures.push(`${JSON.stringify(s)}: positive ${p.ok ? "accepted" : "rejected"}, negative ${n.ok ? "accepted" : "rejected"}`);
      continue;
    }
    if (!(p.value >= 0) || !(n.value <= 0) || p.value + n.value !== 0) failures.push(`${JSON.stringify(s)}: parse=${p.value}, parse(-)=${n.value}`);
  }
  diag(`pairs checked ${inputs.length}, failures ${failures.length}`);
  for (const f of failures.slice(0, 20)) diag(`  ${f}`);
  finish(failures.length ? [`${failures.length} failures; first: ${failures[0]}`] : []);
});
