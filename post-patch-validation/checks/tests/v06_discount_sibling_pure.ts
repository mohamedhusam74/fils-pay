/**
 * L4-V06 variant: the same root cause in a sibling the patch did not touch.
 * parsePromotionalDiscountFils (apps/api/src/payments/discountAdjustment.ts)
 * converts BD text with parseFloat and Math.round(x * 100), i.e. at the
 * 2-decimal "cents" scale ADR-0001 forbids. Invariant: BD text becomes
 * exactly value * 1000 fils or is rejected. Expected to fail on BOTH
 * revisions (missed variant). Reachability (callers in this checkout) is
 * printed to stderr as context; it is not part of the assertion.
 */
import { spawnSync } from "node:child_process";
import { parsePromotionalDiscountFils } from "../src/payments/discountAdjustment.js";
import { attempt, diag, exactOrRejectViolation, finish, reached, run, showOutcome } from "./_lib.js";

const INPUTS = ["4.75", "4.755", "1.005", "0.5", "4.75abc", "4.7555"];

run(() => {
  const grep = spawnSync("git", ["-C", process.env.L4_CHECKOUT ?? ".", "grep", "-n", "parsePromotionalDiscountFils", "--", "apps", "packages"], {
    encoding: "utf8",
  });
  diag(`references in this checkout (git grep exit ${grep.status}):\n${grep.stdout.trim()}`);
  const observed = INPUTS.map((input) => ({ input, got: attempt(parsePromotionalDiscountFils, input) }));
  for (const o of observed) diag(`parsePromotionalDiscountFils(${JSON.stringify(o.input)}) = ${showOutcome(o.got)}`);
  reached();
  const failures = observed.map((o) => exactOrRejectViolation(o.input, o.got)).filter((v): v is string => v !== null);
  finish(failures);
});
