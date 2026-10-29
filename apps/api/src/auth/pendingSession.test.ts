/**
 * A pending (pre-OTP) merchant session must authenticate nothing.
 * 0012_sessions.sql requires every authenticating query to include
 * `authenticated = true`; lookupSession backs both requireSession and
 * requireMerchantAuth, so it must never resolve a pending session.
 * Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { lookupSession } from "./sessions.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "pendingSession.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

// ---------------------------------------------------------------- fixtures

async function createOwner(): Promise<string> {
  const suffix = randomUUID();
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Pending Session ${suffix.slice(0, 8)}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, password_hash, role)
     VALUES ($1, $2, 'unused-in-these-tests', 'owner') RETURNING id`,
    [merchant.rows[0]!.id, `pending-${suffix}@sessions.test`],
  );
  return user.rows[0]!.id;
}

/** An unexpired, unrevoked session; `authenticated` is the only variable. */
async function insertSession(merchantUserId: string, authenticated: boolean): Promise<string> {
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO sessions (merchant_user_id, token_hash, authenticated, expires_at)
     VALUES ($1, $2, $3, now() + interval '10 minutes')`,
    [merchantUserId, sha256Hex(rawToken), authenticated],
  );
  return rawToken;
}

// ------------------------------------------------------------------ tests

test("lookupSession returns null for a pending (pre-OTP) session", async () => {
  const rawToken = await insertSession(await createOwner(), false);

  assert.equal(await lookupSession(pool, rawToken), null);
});

test("a pending session cookie is rejected by requireSession and requireMerchantAuth routes", async () => {
  const merchantUserId = await createOwner();
  const pending = await insertSession(merchantUserId, false);
  const promoted = await insertSession(merchantUserId, true);

  // /v1/auth/me is behind requireSession; /v1/settlement/batches behind requireMerchantAuth.
  for (const url of ["/v1/auth/me", "/v1/settlement/batches"]) {
    const ok = await app.inject({ method: "GET", url, headers: { cookie: `${config.cookieName}=${promoted}` } });
    assert.equal(ok.statusCode, 200, `${url}: an OTP-verified session must be accepted`);

    const res = await app.inject({ method: "GET", url, headers: { cookie: `${config.cookieName}=${pending}` } });
    assert.equal(res.statusCode, 401, `${url}: a pending session must be rejected`);
  }
});
