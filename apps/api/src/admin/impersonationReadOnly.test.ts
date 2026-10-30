/**
 * An admin "view as merchant" grant is read-only: it carries the merchant
 * role 'support' whatever the admin's own role, and it can never become a
 * write actor. Requires DATABASE_URL to point at a real, migrated Postgres
 * (run `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { ForbiddenError } from "../lib/errors.js";
import { randomToken, sha256Hex } from "../lib/crypto.js";
import { lookupImpersonationGrant } from "./impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "impersonationReadOnly.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
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

type AdminRole = "support" | "finance" | "super_admin";
const ADMIN_ROLES: AdminRole[] = ["support", "finance", "super_admin"];

// ---------------------------------------------------------------- fixtures

async function createMerchant(): Promise<string> {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Impersonation ${randomUUID().slice(0, 8)}`],
  );
  return merchant.rows[0]!.id;
}

/** A live grant for a fresh admin of `role` on `merchantId`; returns the raw cookie token. */
async function createGrant(role: AdminRole, merchantId: string): Promise<string> {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused-in-these-tests', $2, $3) RETURNING id`,
    [`${role}-${randomUUID()}@admin.test`, `Test ${role}`, role],
  );
  const rawToken = randomToken(32);
  await pool.query(
    `INSERT INTO admin_impersonation_grants (admin_user_id, merchant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '15 minutes')`,
    [admin.rows[0]!.id, merchantId, sha256Hex(rawToken)],
  );
  return rawToken;
}

// ------------------------------------------------------------------ tests

test("an impersonation grant carries merchant role 'support' for every admin role", async () => {
  const merchantId = await createMerchant();

  for (const role of ADMIN_ROLES) {
    const grant = await lookupImpersonationGrant(pool, await createGrant(role, merchantId));
    assert.equal(grant?.merchantRole, "support", `admin role ${role}`);
  }
});

test("requireMerchantWriterActor refuses an impersonation actor", () => {
  assert.throws(
    () =>
      requireMerchantWriterActor({
        merchantId: randomUUID(),
        actorType: "admin_impersonation",
        actorId: randomUUID(),
        role: "support",
        impersonatedByAdminUserId: randomUUID(),
      }),
    ForbiddenError,
  );
});

test("an impersonating admin can read but cannot create a webhook endpoint, whatever their role", async () => {
  const merchantId = await createMerchant();

  for (const role of ADMIN_ROLES) {
    const cookie = `${config.impersonationCookieName}=${await createGrant(role, merchantId)}`;

    const read = await app.inject({ method: "GET", url: "/v1/settlement/batches", headers: { cookie } });
    assert.equal(read.statusCode, 200, `${role}: reads stay allowed`);

    const write = await app.inject({
      method: "POST",
      url: `/v1/merchants/${merchantId}/webhook-endpoints`,
      headers: { cookie },
      payload: { url: "https://attacker.example/hook" },
    });
    assert.equal(write.statusCode, 403, `${role}: ${write.body}`);
  }
});
