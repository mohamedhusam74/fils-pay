/**
 * L16-B03 behavior (byte-identical stdout on both revisions): the intended
 * benign recovery must survive the patch. A pay attempt that crashes before
 * capture starts (acquirer.authorize throws: nothing pinned, nothing
 * captured) leaves the link 'reserved'. A new buyer is refused while the
 * reservation is younger than the timeout (immediately, and at 59 s) and
 * succeeds once it is older (61 s). Run twice.
 */
import { canonical, finish, out, run } from "./_lib.js";
import { CARDS, CaptureLedger, age, closeHarness, createLink, linkCapturedEvents, linkState, makeBuyer, openHarness, pay, settle, stableBody } from "./_h.js";

run(async () => {
  const h = await openHarness();
  try {
    for (let i = 1; i <= 2; i++) {
      const link = await createLink(h);
      const ledger = new CaptureLedger();
      const crashed = await settle(pay(h, makeBuyer(h.sim, ledger, { authorize: "throw" }).acquirer, link.token, CARDS.approved));
      out(canonical({ run: i, step: "crashed-attempt", rejected: !crashed.ok, link: (await linkState(h, link.linkId)).status }));
      const attempts: Array<[string, number | null]> = [["immediately", null], ["at-59s", 59], ["at-61s", 61]];
      for (const [label, seconds] of attempts) {
        if (seconds !== null) await age(h, link.linkId, seconds);
        const r = await pay(h, makeBuyer(h.sim, ledger, {}).acquirer, link.token, CARDS.approved2);
        out(canonical({ run: i, step: label, statusCode: r.statusCode, body: stableBody((r.body ?? {}) as Record<string, unknown>) }));
      }
      const state = await linkState(h, link.linkId);
      out(canonical({ run: i, step: "final", status: state.status, captures: await linkCapturedEvents(h, link.linkId), approved: ledger.approvedCount }));
    }
  } finally {
    await closeHarness(h);
  }
  finish([]);
});
