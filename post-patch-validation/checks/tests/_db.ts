/**
 * Database / HTTP helpers for the L4 validation scripts. Requires
 * DATABASE_URL (set by ppv.mjs --db to a throwaway, freshly migrated
 * Postgres). Mirrors the setup of the project's own
 * src/routes/adminAdjustmentImport.test.ts (same loadConfig env, same
 * finance-admin login + OTP flow), copied here rather than imported.
 */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/adminAuth/passwords.js";

export const IMPORT_PATH = "/v1/admin/adjustment-imports";

export type AdminRole = "support" | "finance" | "super_admin";

export interface Harness {
  pool: Pool;
  app: ReturnType<typeof buildApp>;
  config: ReturnType<typeof loadConfig>;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; run this script through ppv.mjs --db");
  return url;
}

export async function openHarness(poolMax = 5): Promise<Harness> {
  const url = databaseUrl();
  const config = loadConfig({
    DATABASE_URL: url,
    NODE_ENV: "test",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
  const pool = new Pool({ connectionString: url, max: poolMax });
  const app = buildApp(config, pool);
  await app.ready();
  return { pool, app, config };
}

export async function closeHarness(h: Harness): Promise<void> {
  await h.app.close();
  await h.pool.end();
}

const ADMIN_PASSWORD = "admin-test-password-9000!";
let cachedHash: string | null = null;

function parseCookie(setCookie: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    if (header && header.startsWith(`${name}=`)) return header.split(";")[0] as string;
  }
  throw new Error(`expected a Set-Cookie header for ${name}`);
}

/** Inserts an admin user with the given role and completes password + OTP login. */
export async function signedInAdmin(h: Harness, role: AdminRole): Promise<{ id: string; cookie: string }> {
  cachedHash ??= await hashPassword(ADMIN_PASSWORD, h.config);
  const email = `ppv-l4-${randomUUID()}@admin.test`;
  const inserted = await h.pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, cachedHash, `PPV ${role}`, role],
  );
  const login = await h.app.inject({
    method: "POST",
    url: "/v1/admin/auth/login",
    payload: { email, password: ADMIN_PASSWORD },
  });
  if (login.statusCode !== 200) throw new Error(`admin login failed: ${login.statusCode} ${login.body}`);
  const code = (login.json() as { devOtpCode?: string }).devOtpCode;
  const cookie = parseCookie(login.headers["set-cookie"], h.config.adminCookieName);
  const verify = await h.app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie },
    payload: { code },
  });
  if (verify.statusCode !== 200) throw new Error(`admin OTP verify failed: ${verify.statusCode} ${verify.body}`);
  return { id: inserted.rows[0]!.id, cookie };
}

/** Inserts an admin user row without logging in (for direct service calls). */
export async function createAdminUser(h: Harness, role: AdminRole = "finance"): Promise<string> {
  const r = await h.pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'not-a-real-hash', 'PPV L4', $2) RETURNING id`,
    [`ppv-l4-svc-${randomUUID()}@admin.test`, role],
  );
  return r.rows[0]!.id;
}

export async function createMerchant(h: Harness): Promise<string> {
  const r = await h.pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode)
     VALUES ($1, 250, 'active', false) RETURNING id`,
    [`PPV L4 ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

export function uniqueFilename(tag: string): string {
  return `ppv-l4-${tag}-${randomUUID()}.csv`;
}

export function csv(rows: Array<[string, string, string?]>): string {
  const lines = ["merchantId,amount,reason"];
  for (const [m, a, r] of rows) lines.push(r === undefined ? `${m},${a}` : `${m},${a},${r}`);
  return `${lines.join("\n")}\n`;
}

export interface HttpResult {
  statusCode: number;
  body: string;
}

export async function postCsv(
  h: Harness,
  cookie: string | null,
  csvContent: string,
  originalFilename?: string,
): Promise<HttpResult> {
  const res = await h.app.inject({
    method: "POST",
    url: IMPORT_PATH,
    headers: cookie ? { cookie } : {},
    payload: originalFilename === undefined ? { csvContent } : { csvContent, originalFilename },
  });
  return { statusCode: res.statusCode, body: res.body };
}

export async function getRows(h: Harness, cookie: string, importId: string): Promise<HttpResult> {
  const res = await h.app.inject({ method: "GET", url: `${IMPORT_PATH}/${importId}/rows`, headers: { cookie } });
  return { statusCode: res.statusCode, body: res.body };
}

async function count(h: Harness, sql: string, params: unknown[]): Promise<number> {
  const r = await h.pool.query<{ n: string }>(sql, params);
  return Number(r.rows[0]!.n);
}

/** Row counts in every table the import writes, scoped to the given merchants / filename / admin. */
export async function sinkCounts(
  h: Harness,
  scope: { merchantIds: string[]; filename?: string; adminId?: string },
): Promise<Record<string, number>> {
  const ids = scope.merchantIds;
  return {
    ledger_entries: await count(h, `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE merchant_id = ANY($1::uuid[])`, [ids]),
    merchant_balances: await count(h, `SELECT COUNT(*)::text AS n FROM merchant_balances WHERE merchant_id = ANY($1::uuid[])`, [ids]),
    adjustment_import_rows: await count(
      h,
      `SELECT COUNT(*)::text AS n FROM adjustment_import_rows WHERE merchant_id = ANY($1::uuid[])`,
      [ids],
    ),
    adjustment_imports: scope.filename
      ? await count(h, `SELECT COUNT(*)::text AS n FROM adjustment_imports WHERE original_filename = $1`, [scope.filename])
      : 0,
    admin_audit_log: await count(
      h,
      `SELECT COUNT(*)::text AS n FROM admin_audit_log
        WHERE action = 'adjustment_import_applied'
          AND (metadata->>'originalFilename' = $1 OR admin_user_id::text = $2)`,
      [scope.filename ?? "", scope.adminId ?? ""],
    ),
  };
}

export interface Leg {
  group: string;
  account: string;
  direction: string;
  amount: string;
}

export async function ledgerLegs(h: Harness, merchantId: string): Promise<Leg[]> {
  const r = await h.pool.query<{ entry_group_id: string; account_id: string; direction: string; amount_fils: string }>(
    `SELECT entry_group_id::text AS entry_group_id, account_id, direction, amount_fils::text AS amount_fils
       FROM ledger_entries WHERE merchant_id = $1
      ORDER BY entry_group_id::text, account_id, direction`,
    [merchantId],
  );
  return r.rows.map((x) => ({ group: x.entry_group_id, account: x.account_id, direction: x.direction, amount: x.amount_fils }));
}

/** merchant_balances.cached_payable_fils as text, or null when the row does not exist. */
export async function cachedPayable(h: Harness, merchantId: string): Promise<string | null> {
  const r = await h.pool.query<{ v: string }>(
    `SELECT cached_payable_fils::text AS v FROM merchant_balances WHERE merchant_id = $1`,
    [merchantId],
  );
  return r.rows[0]?.v ?? null;
}

/** The ledger-walk formula of apps/settlement/internal/ledger/rebuild.go RebuildMerchantBalance, verbatim. */
export async function rebuildBalance(h: Harness, merchantId: string): Promise<string> {
  const r = await h.pool.query<{ v: string }>(
    `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS v
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`,
    [merchantId],
  );
  return r.rows[0]!.v;
}

export interface ImportRowDb {
  rowNumber: number;
  merchantId: string;
  raw: string;
  parsed: string;
  reason: string | null;
  group: string | null;
}

export async function importRowsDb(h: Harness, importId: string): Promise<ImportRowDb[]> {
  const r = await h.pool.query<{
    row_number: number;
    merchant_id: string;
    raw_amount_text: string;
    parsed_amount_fils: string;
    reason: string | null;
    ledger_entry_group_id: string | null;
  }>(
    `SELECT row_number, merchant_id::text AS merchant_id, raw_amount_text, parsed_amount_fils::text AS parsed_amount_fils,
            reason, ledger_entry_group_id::text AS ledger_entry_group_id
       FROM adjustment_import_rows WHERE adjustment_import_id = $1 ORDER BY row_number`,
    [importId],
  );
  return r.rows.map((x) => ({
    rowNumber: x.row_number,
    merchantId: x.merchant_id,
    raw: x.raw_amount_text,
    parsed: x.parsed_amount_fils,
    reason: x.reason,
    group: x.ledger_entry_group_id,
  }));
}

/** metadata::text of the adjustment_import_applied audit row(s) for a filename, parsed. */
export async function auditMetadata(h: Harness, filename: string): Promise<Array<Record<string, unknown>>> {
  const r = await h.pool.query<{ m: Record<string, unknown> }>(
    `SELECT metadata AS m FROM admin_audit_log
      WHERE action = 'adjustment_import_applied' AND metadata->>'originalFilename' = $1`,
    [filename],
  );
  return r.rows.map((x) => x.m);
}

/** Two-leg balanced group check: returns problems for every group that is not a balanced pair of |amount|. */
export function groupProblems(legs: Leg[], groupId: string, expectedMagnitude: number, sign: 1 | -1): string[] {
  const mine = legs.filter((l) => l.group === groupId);
  const problems: string[] = [];
  if (mine.length !== 2) problems.push(`group ${groupId} has ${mine.length} legs, expected 2`);
  const want =
    sign > 0
      ? [
          ["manual_balance_adjustment_contra", "debit"],
          ["merchant_payable", "credit"],
        ]
      : [
          ["manual_balance_adjustment_contra", "credit"],
          ["merchant_payable", "debit"],
        ];
  for (const [account, direction] of want) {
    const leg = mine.find((l) => l.account === account);
    if (!leg) {
      problems.push(`group ${groupId} lacks a ${account} leg`);
      continue;
    }
    if (leg.direction !== direction) problems.push(`group ${groupId} ${account} is ${leg.direction}, expected ${direction}`);
    if (leg.amount !== String(expectedMagnitude)) {
      problems.push(`group ${groupId} ${account} amount ${leg.amount}, expected ${expectedMagnitude}`);
    }
  }
  return problems;
}
