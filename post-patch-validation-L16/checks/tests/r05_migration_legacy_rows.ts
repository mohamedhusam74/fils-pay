/**
 * L16-R05 regression (must pass on both). Deploy path for 0073 on a live
 * table. The database is first migrated with this revision's migrations
 * that sort before 0073 only (a pre-deploy schema), and legacy rows are
 * seeded the way the old code leaves them: active, reserved now, reserved
 * two minutes ago (timed out), canceled. Then this revision's own
 * db/migrate.ts runs (applies 0073 on the patched revision, nothing on the
 * base revision) and runs again (must apply nothing). Asserts: every
 * migration applied by the deploy run sorts after 0072, the re-run applies
 * 0, the legacy rows' pre-existing columns are unchanged, and the current
 * pay code treats legacy reservations as before: the timed-out one is
 * claimable (200), the fresh one answers 409 payment_link_processing and
 * becomes claimable once backdated past the timeout.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { diag, finish, run } from "./_lib.js";

function migrate(tree: string, script: string, url: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [process.env.L16_TSX_CLI!, "--no-cache", script], {
    cwd: tree,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
  });
  const out = `${r.stdout}${r.stderr}`;
  diag(`migrate ${path.relative(tree, script)} exit ${r.status}\n${out}`);
  return { code: r.status, out };
}

run(async () => {
  const failures: string[] = [];
  const tree = process.env.L16_TREE!;
  const url = process.env.DATABASE_URL!;
  if (!tree || !url || !process.env.L16_TSX_CLI) throw new Error("run through ppv.mjs --db-empty");

  const pre = path.join(tree, "db-pre-0073");
  fs.mkdirSync(path.join(pre, "migrations"), { recursive: true });
  fs.copyFileSync(path.join(tree, "db", "migrate.ts"), path.join(pre, "migrate.ts"));
  for (const f of fs.readdirSync(path.join(tree, "db", "migrations"))) {
    if (f.endsWith(".sql") && f < "0073") fs.copyFileSync(path.join(tree, "db", "migrations", f), path.join(pre, "migrations", f));
  }
  const m0 = migrate(tree, path.join(pre, "migrate.ts"), url);
  if (m0.code !== 0) throw new Error("pre-0073 migration failed");

  const c = new Client({ connectionString: url });
  await c.connect();
  const ids: Record<string, { id: string; token: string }> = {};
  let merchantId = "";
  try {
    merchantId = (await c.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ('PPV L16 legacy', 250) RETURNING id`)).rows[0]!.id;
    const states: Record<string, string> = {
      active: `'active', NULL, NULL`,
      reserved_fresh: `'reserved', now(), NULL`,
      reserved_stale: `'reserved', now() - interval '2 minutes', NULL`,
      canceled: `'canceled', NULL, now()`,
    };
    for (const [name, values] of Object.entries(states)) {
      const token = `plt_${randomUUID()}`;
      const r = await c.query<{ id: string }>(
        `INSERT INTO payment_links (merchant_id, token, amount_fils, reference, expires_at, created_by_type, created_by_id, status, reserved_at, canceled_at)
         VALUES ($1, $2, 128450, $3, now() + interval '1 day', 'merchant_api_key', $4, ${values}) RETURNING id`,
        [merchantId, token, `legacy-${name}`, randomUUID()],
      );
      ids[name] = { id: r.rows[0]!.id, token };
    }
  } finally {
    await c.end();
  }

  const fingerprint = async () => {
    const cl = new Client({ connectionString: url });
    await cl.connect();
    try {
      const r = await cl.query(
        `SELECT reference, status, reserved_at, transaction_id, paid_at, canceled_at, amount_fils, expires_at, token
           FROM payment_links WHERE merchant_id = $1 ORDER BY reference`,
        [merchantId],
      );
      return JSON.stringify(r.rows);
    } finally {
      await cl.end();
    }
  };
  const before = await fingerprint();

  const m1 = migrate(tree, path.join(tree, "db", "migrate.ts"), url);
  if (m1.code !== 0) failures.push(`deploy migration exited ${m1.code}`);
  const applied = [...m1.out.matchAll(/^APPLY (\S+)/gm)].map((m) => m[1] as string);
  diag(`deploy run applied ${JSON.stringify(applied)}`);
  for (const f of applied) if (f < "0073") failures.push(`deploy run re-applied ${f}`);
  const m2 = migrate(tree, path.join(tree, "db", "migrate.ts"), url);
  if (m2.code !== 0 || !/migrate: 0 migration\(s\) applied/.test(m2.out)) failures.push("re-running the migrations was not a no-op");
  if ((await fingerprint()) !== before) failures.push("legacy rows changed during the migration");

  const { openHarness, closeHarness, makeBuyer, CaptureLedger, CARDS, pay, age, linkState } = await import("./_h.js");
  const { recordKycReview } = await import("../src/onboarding/review.js");
  const h = await openHarness();
  try {
    await recordKycReview(h.pool, { merchantId, outcome: "approved", reviewerIdentifier: "ppv-l16" });
    const ledger = new CaptureLedger();
    const stale = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, ids.reserved_stale!.token, CARDS.approved);
    const fresh = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, ids.reserved_fresh!.token, CARDS.approved2);
    await age(h, ids.reserved_fresh!.id, 61);
    const freshLater = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, ids.reserved_fresh!.token, CARDS.approved3);
    const active = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, ids.active!.token, CARDS.approved);
    diag(`legacy stale ${stale.statusCode} ${JSON.stringify(stale.body)}; legacy fresh ${fresh.statusCode} ${JSON.stringify(fresh.body)}; fresh after timeout ${freshLater.statusCode}; active ${active.statusCode}`);
    if (stale.statusCode !== 200) failures.push(`legacy timed-out reservation not claimable: ${stale.statusCode} ${JSON.stringify(stale.body)}`);
    if (fresh.statusCode !== 409 || (fresh.body as Record<string, unknown>).error !== "payment_link_processing") failures.push(`legacy fresh reservation answered ${fresh.statusCode} ${JSON.stringify(fresh.body)}`);
    if (freshLater.statusCode !== 200) failures.push(`legacy reservation not claimable after the timeout: ${freshLater.statusCode} ${JSON.stringify(freshLater.body)}`);
    if (active.statusCode !== 200) failures.push(`legacy active link not payable: ${active.statusCode}`);
    for (const name of ["reserved_stale", "reserved_fresh", "active"]) {
      const s = await linkState(h, ids[name]!.id);
      if (s.status !== "paid") failures.push(`${name}: ended ${s.status}`);
    }
    if (ledger.approvedCount !== 3) failures.push(`expected 3 approved captures (one per paid link), got ${ledger.approvedCount}`);
  } finally {
    await closeHarness(h);
  }
  finish(failures);
});
