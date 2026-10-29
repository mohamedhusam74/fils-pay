/**
 * Login must bind the OTP challenge and session to the account whose
 * password was verified. merchant_users.email is unique only per merchant
 * (0003), so the same email can exist under several merchants; resolving
 * the session by email alone hands one tenant's login to another tenant.
 * Requires DATABASE_URL to point at a real, migrated Postgres (run
 * `npm run migrate` first).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "otpRecipient.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `npm run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

// ---------------------------------------------------------------- helpers

async function signup(label: string, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `OTP Recipient ${label} ${randomUUID().slice(0, 8)}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `contact-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { merchantId: string }).merchantId;
}

/** Login + OTP verify, then returns the merchant id the session resolves to. */
async function loginAndResolveMerchant(merchantId: string, email: string, password: string): Promise<string> {
  const loginRes = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const { devOtpCode } = loginRes.json() as { devOtpCode: string };
  const setCookie = loginRes.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(";")[0]!;

  const verifyRes = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code: devOtpCode },
  });
  assert.equal(verifyRes.statusCode, 200, verifyRes.body);

  const meRes = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie } });
  assert.equal(meRes.statusCode, 200, meRes.body);
  return (meRes.json() as { merchant: { id: string } }).merchant.id;
}

// ------------------------------------------------------------------ tests

test("a shared email logs into the merchant whose password was verified, not another tenant", async () => {
  const email = `shared-${randomUUID()}@example.test`;
  const merchantA = await signup("A", email, "password-for-merchant-a-1234");
  const merchantB = await signup("B", email, "password-for-merchant-b-5678");

  // Whichever row an email-only lookup picks, it is the same row for both
  // logins, so before the fix at least one of these lands in the wrong tenant.
  assert.equal(await loginAndResolveMerchant(merchantA, email, "password-for-merchant-a-1234"), merchantA);
  assert.equal(await loginAndResolveMerchant(merchantB, email, "password-for-merchant-b-5678"), merchantB);
});
