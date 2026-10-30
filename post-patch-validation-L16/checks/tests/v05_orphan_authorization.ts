/**
 * L16-V05 variant: the losing buyer's authorization as an alternate capture
 * entry point. After the authorize-stall race (E02 interleaving), every
 * authorization the pay endpoint created for this link (idempotency lineage
 * paylink:<linkId>:*:authorize) that is not the link's recorded transaction
 * and is still capturable is submitted to the merchant capture route
 * (POST /v1/transactions/:id/capture with the merchant's API key), as a
 * merchant clicking Capture on an 'authorized' row in the dashboard would.
 * The patch comment claims such an authorization "lapses with the hold".
 *
 * Safety assertion (single-use invariant only): the merchant, whose only
 * sale is this single-use link, has at most one captured transaction and
 * the acquirer approved at most one capture. Side-blind.
 */
import { diag, finish, out, reached, run } from "./_lib.js";
import {
  CaptureLedger,
  LINK_AMOUNT_FILS,
  apiCapture,
  closeHarness,
  instrumentAppAcquirer,
  linkAuthorizations,
  linkState,
  merchantCaptured,
  openHarness,
  raceTwoBuyers,
  summarize,
} from "./_h.js";

run(async () => {
  const h = await openHarness({ app: true });
  const violations: string[] = [];
  try {
    const race = await raceTwoBuyers(h, "authorize", { withApiKey: true });
    if (race.rejections.length > 0) throw new Error(`unexpected rejection: ${race.rejections.join("; ")}`);
    // Merchant-route captures go through the app's simulator; count them in the same ledger.
    instrumentAppAcquirer(h.app!, race.ledger, {});
    const state = await linkState(h, race.link.linkId);
    const auths = await linkAuthorizations(h, race.link.merchantId, race.link.linkId);
    const statuses = await h.pool.query<{ id: string; status: string; hold: string | null }>(
      `SELECT t.id, t.status, (SELECT string_agg(status, ',') FROM holds WHERE transaction_id = t.id) AS hold
         FROM transactions t WHERE t.id = ANY($1::uuid[])`,
      [auths],
    );
    diag(`race: ${summarize(race.responses)} link=${JSON.stringify(state)} linkAuthorizations=${JSON.stringify(statuses.rows)}`);
    const merchantResponses = [];
    for (const row of statuses.rows) {
      if (row.id === state.transactionId) continue;
      if (row.status !== "authorized" && row.status !== "partially_captured") continue;
      const r = await apiCapture(h.app!, race.link.rawKey!, row.id);
      merchantResponses.push(r.statusCode);
      diag(`merchant capture of a leftover link authorization: ${r.statusCode} ${JSON.stringify({ status: r.body.status, error: r.body.error })}`);
    }
    const captured = await merchantCaptured(h, race.link.merchantId);
    out(`race: ${summarize(race.responses)} leftoverCaptureAttempts=${merchantResponses.length}`);
    diag(`merchant captured=${JSON.stringify(captured)} approved=${race.ledger.approvedCount}`);
    if (captured.count > 1 || captured.sum > LINK_AMOUNT_FILS) {
      violations.push(`the merchant collected ${captured.count} captures (${captured.sum} fils) for one single-use link of ${LINK_AMOUNT_FILS} fils`);
    }
    if (race.ledger.approvedCount > 1) violations.push(`the acquirer approved ${race.ledger.approvedCount} captures for one single-use link`);
  } finally {
    await closeHarness(h);
  }
  reached();
  finish(violations);
});
