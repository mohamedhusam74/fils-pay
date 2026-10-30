/**
 * L4-R06 regression (both revisions must pass): the fix must not reject
 * valid input. Over the same fixed-seed corpus as L4-V05 (seed 0x4C340001)
 * plus edges, every ADR-0001-valid amount (plain ASCII decimal, at most
 * three decimals, within the safe range) is accepted, and every accepted
 * value is a safe integer. Base also accepts all of these (with wrong
 * values, which L4-V05 catches); this check guards the opposite failure.
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { amountCorpus, attempt, bucketOf, diag, EDGE_INPUTS, finish, run } from "./_lib.js";

run(() => {
  const corpus = [...amountCorpus(0x4c340001, 20_000), ...EDGE_INPUTS.map((input) => ({ input, bucket: bucketOf(input) }))];
  const failures: string[] = [];
  let valid = 0;
  for (const c of corpus) {
    const o = attempt(parseAdjustmentAmountFils, c.input);
    if (o.ok && !Number.isSafeInteger(o.value)) failures.push(`${JSON.stringify(c.input)} accepted as non-safe-integer ${o.value}`);
    if (!c.bucket.startsWith("valid-")) continue;
    valid++;
    if (!o.ok) failures.push(`${JSON.stringify(c.input)} (${c.bucket}) is valid under ADR-0001 but was rejected: ${o.message}`);
  }
  diag(`ADR-valid inputs checked: ${valid}; failures: ${failures.length}`);
  for (const f of failures.slice(0, 20)) diag(`  ${f}`);
  finish(failures.length ? [`${failures.length} failures; first: ${failures[0]}`] : []);
});
