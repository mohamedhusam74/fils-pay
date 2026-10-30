/**
 * L4-B01 behavior (stdout byte-identical on both revisions): the
 * accept/reject contract of parseAdjustmentAmountFils outside the intended
 * change. (1) Every malformed input is rejected on both revisions with the
 * identical BadRequestError (status 400, code invalid_amount, message
 * 'could not parse amount "<raw>"'). (2) Inputs with up to two decimals,
 * signs, leading zeros and trim-able whitespace (space, tab, NBSP, BOM) are
 * accepted on both with the same sign class. Values are deliberately not
 * printed: they change by design (x10) and are asserted by L4-E01/L4-V05.
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, out, run } from "./_lib.js";

const MALFORMED = [
  "", " ", "-", "abc", "not-a-number", "+1.00", "+4.75", ".5", ".75", "5.", "4.", "1e3", "4.75abc", "0x10",
  "Infinity", "NaN", "--1", "1.2.3", "4. 75", "4 .75", "٤.٧٥", "٤.75", "１", "４.７５", "−4.75", "1,000.50", "1_000",
  `1${"0".repeat(400)}`, "90071992547409.92",
];

function accepted(): string[] {
  const ints = ["0", "1", "7", "9", "10", "99", "100", "120", "999", "1000", "123456", "007", "0000"];
  const fracs = ["", ".0", ".5", ".9", ".00", ".05", ".50", ".75", ".99"];
  const list: string[] = [];
  for (const sign of ["", "-"]) for (const i of ints) for (const f of fracs) list.push(`${sign}${i}${f}`);
  for (const core of ["4.75", "-1.25", "4.755", "0004.750", "1.001"]) {
    for (const pad of [" ", "\t", " ", "﻿"]) list.push(`${pad}${core}${pad}`);
  }
  return list;
}

function signClass(v: number): string {
  return v === 0 ? "zero" : v > 0 ? "positive" : "negative";
}

run(() => {
  for (const input of [...MALFORMED, ...accepted()]) {
    const o = attempt(parseAdjustmentAmountFils, input);
    const shown = input.length > 64 ? `${JSON.stringify(input.slice(0, 16))}...(${input.length} chars)` : JSON.stringify(input);
    if (o.ok) out(`${shown}\taccepted\t${signClass(o.value)}`);
    else out(`${shown}\trejected\t${o.ctor}\t${String(o.statusCode)}\t${String(o.code)}\t${JSON.stringify(o.message)}`);
  }
  process.exit(0);
});
