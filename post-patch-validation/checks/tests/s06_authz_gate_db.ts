/**
 * L4-S06 security (must pass on both revisions): who can post money through
 * the import route is unchanged. No session -> 401; a support admin -> 403;
 * only merchant-side cookies (merchant session and impersonation cookie
 * names with random values) -> 401; none of these writes anything. A
 * super_admin -> 201. The route and middleware are not in the diff; this
 * pins that the gate still fronts the patched parser.
 */
import { randomBytes } from "node:crypto";
import { closeHarness, createMerchant, csv, openHarness, postCsv, signedInAdmin, sinkCounts, uniqueFilename } from "./_db.js";
import { diag, finish, run } from "./_lib.js";

run(async () => {
  const failures: string[] = [];
  const h = await openHarness();
  try {
    const m = await createMerchant(h);
    const body = csv([[m, "4.755", "authz"]]);
    const support = await signedInAdmin(h, "support");
    const merchantCookies = `${h.config.cookieName}=${randomBytes(24).toString("hex")}; ${h.config.impersonationCookieName}=${randomBytes(24).toString("hex")}`;
    const attempts: Array<[string, string | null, number]> = [
      ["no session", null, 401],
      ["support admin", support.cookie, 403],
      ["merchant cookies only", merchantCookies, 401],
    ];
    for (const [label, cookie, want] of attempts) {
      const filename = uniqueFilename("s06");
      const res = await postCsv(h, cookie, body, filename);
      const counts = await sinkCounts(h, { merchantIds: [m], filename });
      diag(`${label}: ${res.statusCode} ${res.body} ${JSON.stringify(counts)}`);
      if (res.statusCode !== want) failures.push(`${label}: ${res.statusCode}, expected ${want}`);
      for (const [t, n] of Object.entries(counts)) if (n !== 0) failures.push(`${label}: ${n} row(s) in ${t}`);
    }
    const sa = await signedInAdmin(h, "super_admin");
    const ok = await postCsv(h, sa.cookie, body, uniqueFilename("s06-sa"));
    diag(`super_admin: ${ok.statusCode} ${ok.body}`);
    if (ok.statusCode !== 201) failures.push(`super_admin: ${ok.statusCode}, expected 201`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
