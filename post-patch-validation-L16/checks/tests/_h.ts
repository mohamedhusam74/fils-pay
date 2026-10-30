/**
 * Payment-link harness for the L16 checks. Everything here drives the real
 * project code of the revision under test (../src/...): loadConfig, buildApp,
 * the acquirer simulator, payPaymentLink, authorize/capture, recordKycReview,
 * issueApiKey. Only the acquirer is wrapped (gates, outcome overrides,
 * capture counting) and, for crash/lock-race checks, pool.query is hooked.
 *
 * Requires DATABASE_URL (set by ppv.mjs --db to a throwaway, freshly
 * migrated Postgres).
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { createAcquirerSimulator } from "../src/acquirer/simulator.js";
import type {
  AcquirerAuthorizeRequest,
  AcquirerAuthorizeResult,
  AcquirerCaptureRequest,
  AcquirerCaptureResult,
  AcquirerSimulator,
} from "../src/acquirer/types.js";
import { recordKycReview } from "../src/onboarding/review.js";
import { issueApiKey } from "../src/apiKeys/issue.js";
import { payPaymentLink, type PayPaymentLinkResult } from "../src/paymentLinks/pay.js";
import { diag } from "./_lib.js";

export const LINK_AMOUNT_FILS = 128_450;
export const TIMEOUT_SECONDS = 60;
export const LINK_REFERENCE = "ppv-l16-order";

function card(pan: string) {
  return { pan, expiryMonth: 12, expiryYear: 2030, cvv: "123" };
}

/** Simulator magic PANs: ...0002 declines (do_not_honor), ...0069 is an acquirer error. */
export const CARDS = {
  approved: card("4242424242424242"),
  approved2: card("5555555555554444"),
  approved3: card("4111111111111111"),
  declined: card("4000000000000002"),
  error: card("4000000000000069"),
} as const;

export type Card = ReturnType<typeof card>;
export type Config = ReturnType<typeof loadConfig>;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; run this script through ppv.mjs --db");
  return url;
}

/** The same config the project's own payment-link tests use. */
export function makeConfig(): Config {
  return loadConfig({
    DATABASE_URL: databaseUrl(),
    NODE_ENV: "test",
    INTERNAL_API_TOKEN: "test-internal-token",
    ACQUIRER_FAILURE_RATE: "0",
    ACQUIRER_LATENCY_MIN_MS: "0",
    ACQUIRER_LATENCY_MAX_MS: "1",
    PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: String(TIMEOUT_SECONDS),
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  });
}

export interface Harness {
  config: Config;
  pool: Pool;
  /** One shared simulator: every buyer wrapper delegates to it. */
  sim: AcquirerSimulator;
  app: FastifyInstance | null;
}

export async function openHarness(opts: { app?: boolean; poolMax?: number } = {}): Promise<Harness> {
  const config = makeConfig();
  const pool = new Pool({ connectionString: databaseUrl(), max: opts.poolMax ?? 12 });
  const sim = createAcquirerSimulator(config);
  let app: FastifyInstance | null = null;
  if (opts.app) {
    app = buildApp(config, pool);
    await app.ready();
  }
  return { config, pool, sim, app };
}

export async function closeHarness(h: Harness): Promise<void> {
  if (h.app) await h.app.close();
  await h.pool.end();
}

// ------------------------------------------------------------ acquirer

/** Counts acquirer-approved captures (distinct acquirerReference + acquirer idempotency key). */
export class CaptureLedger {
  private readonly approved = new Set<string>();

  record(req: AcquirerCaptureRequest, res: AcquirerCaptureResult): void {
    if (res.outcome === "approved") this.approved.add(`${req.acquirerReference}|${req.idempotencyKey}`);
  }

  get approvedCount(): number {
    return this.approved.size;
  }
}

export type CaptureMode = "real" | "declined" | "error" | "throw-before" | "throw-after";

export interface BuyerOptions {
  /** Hold the first call of this step until release(). */
  stallAt?: "authorize" | "capture";
  /** "throw": the first authorize call rejects (crash before the acquirer answered). */
  authorize?: "real" | "throw";
  /**
   * First capture call only: "declined"/"error" return that outcome without
   * reaching the acquirer; "throw-before" rejects before reaching it;
   * "throw-after" lets the acquirer approve (counted) and then rejects, as a
   * transport failure after the acquirer's response would. Later calls are real.
   */
  capture?: CaptureMode;
}

export interface Buyer {
  acquirer: AcquirerSimulator;
  isParked(): boolean;
  waitParked(label: string): Promise<void>;
  release(): void;
}

/** A per-buyer acquirer over the shared simulator, sharing one capture ledger. */
export function makeBuyer(sim: AcquirerSimulator, ledger: CaptureLedger, opts: BuyerOptions = {}): Buyer {
  let parked = false;
  let stalled = false;
  let authorizeOverridden = false;
  let captureOverridden = false;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  async function maybeStall(step: "authorize" | "capture"): Promise<void> {
    if (opts.stallAt !== step || stalled) return;
    stalled = true;
    parked = true;
    await gate;
    parked = false;
  }

  const acquirer: AcquirerSimulator = {
    async authorize(req: AcquirerAuthorizeRequest): Promise<AcquirerAuthorizeResult> {
      await maybeStall("authorize");
      if (opts.authorize === "throw" && !authorizeOverridden) {
        authorizeOverridden = true;
        throw new Error("ppv: simulated crash inside acquirer.authorize");
      }
      return sim.authorize(req);
    },
    async capture(req: AcquirerCaptureRequest): Promise<AcquirerCaptureResult> {
      await maybeStall("capture");
      const mode: CaptureMode = captureOverridden ? "real" : (opts.capture ?? "real");
      if (mode !== "real") captureOverridden = true;
      if (mode === "declined" || mode === "error") {
        return { outcome: mode, acquirerReference: req.acquirerReference, latencyMs: 0 };
      }
      if (mode === "throw-before") {
        throw new Error("ppv: ECONNRESET before the capture request reached the acquirer");
      }
      const res = await sim.capture(req);
      ledger.record(req, res);
      if (mode === "throw-after") {
        throw new Error("ppv: socket hang up after the acquirer approved the capture");
      }
      return res;
    },
    refund: (req) => sim.refund(req),
  };

  return {
    acquirer,
    isParked: () => parked,
    async waitParked(label: string) {
      for (let i = 0; i < 2000 && !parked; i++) await delay(5);
      if (!parked) throw new Error(`timed out waiting for ${label} to reach its acquirer gate`);
    },
    release: () => openGate(),
  };
}

/** Replaces the app's own simulator methods in place (route handlers share that object). */
export function instrumentAppAcquirer(app: FastifyInstance, ledger: CaptureLedger, opts: BuyerOptions = {}): Buyer {
  const appSim = (app as unknown as { acquirer: AcquirerSimulator }).acquirer;
  const real: AcquirerSimulator = {
    authorize: appSim.authorize,
    capture: appSim.capture,
    refund: appSim.refund,
  };
  const buyer = makeBuyer(real, ledger, opts);
  appSim.authorize = buyer.acquirer.authorize;
  appSim.capture = buyer.acquirer.capture;
  return buyer;
}

// ------------------------------------------------------------ pool hooks

type QueryHook = (sql: string, params: unknown[] | undefined) => Promise<unknown> | undefined;

/** A Pool whose query() can be intercepted; connect() and everything else go to the real pool. */
export function hookQueries(pool: Pool, hook: QueryHook): Pool {
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "query") {
        return (text: unknown, params?: unknown[]) => {
          if (typeof text === "string") {
            const intercepted = hook(text, params);
            if (intercepted !== undefined) return intercepted;
          }
          return (target.query as (t: unknown, p?: unknown[]) => Promise<unknown>)(text, params);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Pool;
}

/** Rejects (once) the first query whose SQL matches, before it reaches Postgres: a crash at that point. */
export function crashBefore(pool: Pool, match: RegExp, message: string): { pool: Pool; fired(): boolean } {
  let fired = false;
  const hooked = hookQueries(pool, (sql) => {
    if (fired || !match.test(sql)) return undefined;
    fired = true;
    return Promise.reject(new Error(message));
  });
  return { pool: hooked, fired: () => fired };
}

const PAYMENT_LINKS_UPDATE = /^\s*UPDATE\s+payment_links\b/i;

export interface HeldStatement {
  pool: Pool;
  waitHeld(label: string): Promise<void>;
  commit(): void;
}

/**
 * Runs the nth `UPDATE payment_links` statement issued through the returned
 * pool inside an explicit transaction on a dedicated client and keeps it
 * uncommitted (row lock held) until commit() is called.
 */
export function holdNthLinkUpdate(pool: Pool, nth: number): HeldStatement {
  let seen = 0;
  let held = false;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const hooked = hookQueries(pool, (sql, params) => {
    if (!PAYMENT_LINKS_UPDATE.test(sql)) return undefined;
    seen += 1;
    if (seen !== nth) return undefined;
    return (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(sql, params);
        held = true;
        await gate;
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        held = false;
        client.release();
      }
    })();
  });
  return {
    pool: hooked,
    async waitHeld(label: string) {
      for (let i = 0; i < 2000 && !held; i++) await delay(5);
      if (!held) throw new Error(`timed out waiting for ${label} to be held uncommitted`);
    },
    commit: () => openGate(),
  };
}

/** Waits until at least `min` backends are blocked on a row lock in an UPDATE payment_links. */
export async function waitLockWaiters(pool: Pool, min: number, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%UPDATE payment_links%'`,
    );
    if ((r.rows[0]?.n ?? 0) >= min) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${label} to block on the payment_links row lock`);
}

// ------------------------------------------------------------ fixtures

export interface LinkFixture {
  merchantId: string;
  linkId: string;
  token: string;
  rawKey: string | null;
}

/** A KYC-approved merchant (optionally with an owner API key) and one active link. */
export async function createLink(
  h: Harness,
  opts: { withApiKey?: boolean; amountFils?: number; reference?: string | null } = {},
): Promise<LinkFixture> {
  const merchant = await h.pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`PPV L16 ${randomUUID().slice(0, 8)}`],
  );
  const merchantId = merchant.rows[0]!.id;
  let rawKey: string | null = null;
  let ownerUserId: string | null = null;
  if (opts.withApiKey) {
    const user = await h.pool.query<{ id: string }>(
      `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
       VALUES ($1, $2, 'owner', 'unused-in-these-checks') RETURNING id`,
      [merchantId, `owner-${randomUUID()}@ppv-l16.test`],
    );
    ownerUserId = user.rows[0]!.id;
  }
  await recordKycReview(h.pool, { merchantId, outcome: "approved", reviewerIdentifier: "ppv-l16" });
  if (ownerUserId) {
    const issued = await issueApiKey(h.pool, h.config, { merchantId, createdBy: ownerUserId, label: "ppv-l16" });
    rawKey = issued.rawKey;
  }
  const token = `plt_${randomUUID()}`;
  const link = await h.pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, reference, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, now() + interval '1 day', 'merchant_api_key', $5) RETURNING id`,
    [merchantId, token, opts.amountFils ?? LINK_AMOUNT_FILS, opts.reference === undefined ? LINK_REFERENCE : opts.reference, randomUUID()],
  );
  return { merchantId, linkId: link.rows[0]!.id, token, rawKey };
}

/** Backdates the reservation so it looks `seconds` old (the timeout is 60 s). */
export async function age(h: Harness, linkId: string, seconds: number): Promise<void> {
  await h.pool.query(`UPDATE payment_links SET reserved_at = now() - make_interval(secs => $2) WHERE id = $1`, [
    linkId,
    seconds,
  ]);
}

export async function hasColumn(h: Harness, table: string, column: string): Promise<boolean> {
  const r = await h.pool.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rowCount === 1;
}

export interface LinkState {
  status: string;
  transactionId: string | null;
  reservedAtNull: boolean;
  paidAtNull: boolean;
  /** undefined when the column does not exist on this schema. */
  reservationId: string | null | undefined;
  captureStartedAt: string | null | undefined;
}

export async function linkState(h: Harness, linkId: string): Promise<LinkState> {
  const r = await h.pool.query<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(pl) AS j FROM payment_links pl WHERE id = $1`,
    [linkId],
  );
  const j = r.rows[0]?.j;
  if (!j) throw new Error(`payment link ${linkId} disappeared`);
  return {
    status: String(j.status),
    transactionId: (j.transaction_id as string | null) ?? null,
    reservedAtNull: j.reserved_at === null,
    paidAtNull: j.paid_at === null,
    reservationId: "reservation_id" in j ? ((j.reservation_id as string | null) ?? null) : undefined,
    captureStartedAt: "capture_started_at" in j ? ((j.capture_started_at as string | null) ?? null) : undefined,
  };
}

/** Pay-path captures recorded against the link (capture actor = system / link id). */
export async function linkCapturedEvents(h: Harness, linkId: string): Promise<{ count: number; sum: number }> {
  const r = await h.pool.query<{ n: number; s: string }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(amount_fils), 0)::text AS s
       FROM transaction_events
      WHERE actor_type = 'system' AND actor_id = $1 AND event_type IN ('captured', 'partially_captured')`,
    [linkId],
  );
  return { count: r.rows[0]!.n, sum: Number(r.rows[0]!.s) };
}

/** Every captured event for the merchant, whoever captured. */
export async function merchantCaptured(h: Harness, merchantId: string): Promise<{ count: number; sum: number }> {
  const r = await h.pool.query<{ n: number; s: string }>(
    `SELECT count(*)::int AS n, COALESCE(SUM(te.amount_fils), 0)::text AS s
       FROM transaction_events te JOIN transactions t ON t.id = te.transaction_id
      WHERE t.merchant_id = $1 AND te.event_type IN ('captured', 'partially_captured')`,
    [merchantId],
  );
  return { count: r.rows[0]!.n, sum: Number(r.rows[0]!.s) };
}

/** Transactions the pay endpoint authorized for this link (idempotency lineage). */
export async function linkAuthorizations(h: Harness, merchantId: string, linkId: string): Promise<string[]> {
  const r = await h.pool.query<{ resource_id: string }>(
    `SELECT resource_id::text AS resource_id FROM idempotency_keys
      WHERE merchant_id = $1 AND endpoint = 'transactions.authorize'
        AND key LIKE $2 AND resource_id IS NOT NULL
      ORDER BY created_at`,
    [merchantId, `paylink:${linkId}:%:authorize`],
  );
  return r.rows.map((x) => x.resource_id);
}

export async function transactionCount(h: Harness, merchantId: string): Promise<number> {
  const r = await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM transactions WHERE merchant_id = $1`, [
    merchantId,
  ]);
  return r.rows[0]!.n;
}

// ------------------------------------------------------------ paying

export interface PayResponse {
  label: string;
  statusCode: number;
  body: Record<string, unknown>;
}

export function pay(
  h: Harness,
  acquirer: AcquirerSimulator,
  token: string,
  cardInput: Card,
  idempotencyKey: string = randomUUID(),
  pool: Pool = h.pool,
): Promise<PayPaymentLinkResult> {
  return payPaymentLink(pool, acquirer, h.config, { token, card: cardInput, idempotencyKey });
}

export function asResponse(label: string, r: PayPaymentLinkResult): PayResponse {
  return { label, statusCode: r.statusCode, body: (r.body ?? {}) as Record<string, unknown> };
}

export async function injectPay(
  app: FastifyInstance,
  label: string,
  token: string,
  cardInput: Card,
  idempotencyKey: string = randomUUID(),
): Promise<PayResponse> {
  const res = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": idempotencyKey },
    payload: { card: cardInput },
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = { raw: res.body };
  }
  return { label, statusCode: res.statusCode, body };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Attaches handlers immediately so an expected rejection is never "unhandled". */
export function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Counts the pay endpoint's "finalize UPDATE matched 0 rows" invariant-violation log line. */
export function spyFinalizeInvariantLog(): { count(): number } {
  let n = 0;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (args.some((a) => typeof a === "string" && a.includes("finalize UPDATE matched 0 rows"))) n += 1;
    original(...args);
  };
  return { count: () => n };
}

// ------------------------------------------------------------ the security invariant

/**
 * The single-use invariant the finding is about, and nothing else:
 *  (1) the acquirer approves at most one capture for the link's buyers;
 *  (2) at most one pay-path capture is recorded against the link;
 *  (3) every 200 'paid' answer names the transaction the link records.
 */
export async function singleUseViolations(
  h: Harness,
  linkId: string,
  ledger: CaptureLedger,
  responses: PayResponse[],
): Promise<string[]> {
  const violations: string[] = [];
  const state = await linkState(h, linkId);
  if (ledger.approvedCount > 1) {
    violations.push(`the acquirer approved ${ledger.approvedCount} captures for one single-use link`);
  }
  const events = await linkCapturedEvents(h, linkId);
  if (events.count > 1) {
    violations.push(`${events.count} pay-path captures (${events.sum} fils) are recorded against one link`);
  }
  for (const r of responses) {
    if (r.statusCode !== 200 || r.body.status !== "paid") continue;
    if (r.body.transactionId !== state.transactionId) {
      violations.push(
        `${r.label} answered 200 'paid' for a transaction the link does not record ` +
          `(link status ${state.status}, link transaction ${state.transactionId === null ? "none" : "a different one"})`,
      );
    }
  }
  return violations;
}

/** A stable one-line summary of responses for evidence logs. */
export function summarize(responses: PayResponse[]): string {
  return responses
    .map((r) => `${r.label}=${r.statusCode}:${String(r.body.error ?? r.body.status ?? "")}`)
    .join(" ");
}

export function logDiag(label: string, value: unknown): void {
  diag(`${label}: ${JSON.stringify(value)}`);
}
