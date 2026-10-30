/**
 * L4-E01 exploit (fails on base, passes on patch): the original finding as a
 * pure assertion on the real parseAdjustmentAmountFils of this revision.
 * ADR-0001: 1 BD = 1000 fils, up to three decimals, never truncated. The
 * expected values come from that rule (finding examples), not from the
 * patch's own test file.
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { attempt, diag, finish, reached, run, showOutcome } from "./_lib.js";

const ADR_0001: ReadonlyArray<[string, number]> = [
  ["4.75", 4750],
  ["4.750", 4750],
  ["4.755", 4755],
  ["0.005", 5],
  ["120.00", 120_000],
  ["-3.50", -3500],
];

run(() => {
  const observed = ADR_0001.map(([input, want]) => ({ input, want, got: attempt(parseAdjustmentAmountFils, input) }));
  for (const o of observed) diag(`parseAdjustmentAmountFils(${JSON.stringify(o.input)}) = ${showOutcome(o.got)} (ADR-0001: ${o.want})`);
  reached();
  const failures = observed
    .filter((o) => !(o.got.ok && o.got.value === o.want))
    .map((o) => `${JSON.stringify(o.input)} -> ${showOutcome(o.got)}, expected ${o.want} fils`);
  finish(failures);
});
