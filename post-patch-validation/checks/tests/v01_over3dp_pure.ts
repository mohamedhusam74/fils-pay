/**
 * L4-V01 variant (fails on base, passes on patch): digits beyond the third
 * decimal. A BD text whose value is not a whole number of fils (4.7555 BD,
 * 0.0001 BD) cannot be posted exactly, so it must be rejected; one whose
 * extra digits are zeros (4.7500) must be rejected or posted exactly. Base
 * truncates all of them (475 / 0 / 475). Security invariant only: exact or
 * rejected. The exact rejection code is checked by L4-R01.
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, diag, exactOrRejectViolation, finish, reached, run, showOutcome } from "./_lib.js";

const INPUTS = ["4.7555", "0.0001", "-0.0001", "4.7500", "120.0000", "1.23456789", "-2.0019"];

run(() => {
  const observed = INPUTS.map((input) => ({ input, got: attempt(parseAdjustmentAmountFils, input) }));
  for (const o of observed) diag(`parseAdjustmentAmountFils(${JSON.stringify(o.input)}) = ${showOutcome(o.got)}`);
  reached();
  const failures = observed.map((o) => exactOrRejectViolation(o.input, o.got)).filter((v): v is string => v !== null);
  finish(failures);
});
