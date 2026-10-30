/**
 * GET /v1/transactions/export must not load a merchant's whole history into
 * memory (the API runs in 512 MB): no single query may return more than one
 * page, and paging must still export every row exactly once, including rows
 * that share a timestamp across a page boundary. Requires DATABASE_URL to
 * point at a real, migrated Postgres (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type QueryResult } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "exportStreaming.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const PAGE_SIZE = 1000;
const ROW_COUNT = PAGE_SIZE + 5;

test("the CSV export pages its reads and exports every row once across a shared-timestamp boundary", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export Streaming ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchantId, `export-${randomUUID()}@export.test`],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, true, now() + interval '1 hour')`,
    [user.rows[0]!.id, sha256Hex(rawToken)],
  );
  // Every row shares one timestamp, so a page boundary falls inside the tie.
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 4750, 4750, 'acq_export_' || g, TIMESTAMPTZ '2026-09-15 10:00:00.123456+00'
       FROM generate_series(1, $2) AS g`,
    [merchantId, ROW_COUNT],
  );

  let largestResult = 0;
  const originalQuery = pool.query.bind(pool);
  pool.query = (async (...args: Parameters<typeof originalQuery>) => {
    const result = (await (originalQuery as (...a: unknown[]) => Promise<QueryResult>)(...args));
    largestResult = Math.max(largestResult, result.rows?.length ?? 0);
    return result;
  }) as typeof pool.query;

  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/transactions/export",
      headers: { cookie: `${config.cookieName}=${rawToken}` },
    });
    assert.equal(res.statusCode, 200, res.body);

    const lines = res.body.split("\n").filter((line) => line !== "");
    const ids = lines.slice(1).map((line) => line.split(",")[0]);
    assert.equal(ids.length, ROW_COUNT, "every row exported");
    assert.equal(new Set(ids).size, ROW_COUNT, "no row exported twice");
    assert.ok(largestResult <= PAGE_SIZE, `a single query returned ${largestResult} rows; expected at most ${PAGE_SIZE}`);
  } finally {
    pool.query = originalQuery;
  }
});
