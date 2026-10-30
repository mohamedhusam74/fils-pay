/**
 * L4-R01 regression (both revisions must pass): inputs with more than three
 * decimals moved from accepted (base, truncated) to rejected (patch,
 * ADR-0001 rule 3). Whatever a revision does with them, it must be one of
 * the two documented outcomes: 201, or exactly
 * 400 {"error":"invalid_amount","message":"could not parse amount \"<amt>\""}
 * with every sink empty -- never a 500 or a partial commit. Then the pool
 * must still be healthy: 7 consecutive uploads of that class (more than the
 * pool's 5 clients) each answer within 5 s and a valid upload still returns
 * 201 within 5 s (withTransaction released every client).
 */
import { closeHarness, createMerchant, csv, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, run, withTimeout } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness(5);
  try {
    const admin = await signedInAdmin(h, "finance");
    for (const amt of ["4.7555", "4.7500", "120.0000", "-0.0001"]) {
      const m = await createMerchant(h);
      const filename = uniqueFilename("r01");
      const res = await postCsv(h, admin.cookie, csv([[m, "1.00", "ok"], [m, amt, "x"]]), filename);
      const counts = await sinkCounts(h, { merchantIds: [m], filename });
      diag(`${amt}: ${res.statusCode} ${res.body} counts ${JSON.stringify(counts)}`);
      const want400 = JSON.stringify({ error: "invalid_amount", message: `could not parse amount "${amt}"` });
      if (res.statusCode === 201) continue;
      if (res.statusCode !== 400 || res.body !== want400) failures.push(`${amt}: got ${res.statusCode} ${res.body}, expected 201 or 400 ${want400}`);
      for (const [table, n] of Object.entries(counts)) if (n !== 0) failures.push(`${amt}: rejected upload left ${n} row(s) in ${table}`);
    }
    const m = await createMerchant(h);
    for (let i = 0; i < 7; i++) {
      try {
        const res = await withTimeout(postCsv(h, admin.cookie, csv([[m, "1.00", "ok"], [m, "4.7555", "x"]]), uniqueFilename(`r01-loop${i}`)), 5000, `upload ${i}`);
        if (res.statusCode !== 201 && res.statusCode !== 400) failures.push(`loop upload ${i} returned ${res.statusCode}`);
      } catch (err) {
        failures.push((err as Error).message);
        break;
      }
    }
    try {
      const res = await withTimeout(postCsv(h, admin.cookie, csv([[m, "2.00", "after loop"]]), uniqueFilename("r01-after")), 5000, "valid upload after loop");
      diag(`valid upload after loop: ${res.statusCode}; pool total=${h.pool.totalCount} idle=${h.pool.idleCount} waiting=${h.pool.waitingCount}`);
      if (res.statusCode !== 201) failures.push(`valid upload after the loop returned ${res.statusCode}`);
    } catch (err) {
      failures.push(`${(err as Error).message} (pool total=${h.pool.totalCount} idle=${h.pool.idleCount} waiting=${h.pool.waitingCount})`);
    }
  } finally {
    await closeHarness(h).catch((err: unknown) => diag(`close failed: ${String(err)}`));
  }
  finish(failures);
});
