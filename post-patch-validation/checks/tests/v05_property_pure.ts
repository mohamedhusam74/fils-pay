/**
 * L4-V05 variant (fails on base, passes on patch): the whole input domain
 * instead of hand-picked values. A fixed-seed corpus (mulberry32, seed
 * 0x4C340001, 20000 generated cases + fixed edges) is run through this
 * revision's parseAdjustmentAmountFils and checked against an independent
 * BigInt ADR-0001 oracle: every input is either rejected or parsed to
 * exactly its fils value. Bucket quotas are enforced before the marker so
 * the corpus provably reaches every class (0/1-2/3 decimals, >3 decimals,
 * unsafe magnitude, junk).
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { amountCorpus, attempt, bucketOf, diag, EDGE_INPUTS, exactOrRejectViolation, finish, reached, run } from "./_lib.js";

const SEED = 0x4c340001;
const N = 20_000;
const QUOTAS: Record<string, number> = {
  "valid-0dp": 1000,
  "valid-1to2dp": 1000,
  "valid-3dp": 1000,
  "over3dp-fractional": 1000,
  unsafe: 500,
  junk: 500,
};

run(() => {
  const corpus = [...amountCorpus(SEED, N), ...EDGE_INPUTS.map((input) => ({ input, bucket: bucketOf(input) }))];
  const buckets: Record<string, number> = {};
  for (const c of corpus) buckets[c.bucket] = (buckets[c.bucket] ?? 0) + 1;
  diag(`seed=0x${SEED.toString(16)} cases=${corpus.length} buckets=${JSON.stringify(buckets)}`);
  for (const [bucket, min] of Object.entries(QUOTAS)) {
    if ((buckets[bucket] ?? 0) < min) throw new Error(`corpus bucket ${bucket} has ${buckets[bucket] ?? 0} < ${min} cases`);
  }
  const violations: Array<{ bucket: string; message: string }> = [];
  for (const c of corpus) {
    const v = exactOrRejectViolation(c.input, attempt(parseAdjustmentAmountFils, c.input));
    if (v) violations.push({ bucket: c.bucket, message: v });
  }
  const byBucket: Record<string, number> = {};
  for (const v of violations) byBucket[v.bucket] = (byBucket[v.bucket] ?? 0) + 1;
  diag(`violations=${violations.length} by bucket=${JSON.stringify(byBucket)}`);
  for (const v of violations.slice(0, 20)) diag(`  [${v.bucket}] ${v.message}`);
  reached();
  finish(violations.length === 0 ? [] : [`${violations.length} inputs violate exact-or-reject; first: ${violations[0]!.message}`]);
});
