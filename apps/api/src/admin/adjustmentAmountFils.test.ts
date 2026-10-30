/**
 * Adjustment CSV amounts are BD with up to three decimals; 1 BD = 1000 fils
 * (ADR-0001). Pure — no database.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

test("CSV amounts convert BD to fils at 1000 fils per BD", () => {
  assert.equal(parseAdjustmentAmountFils("4.755"), 4755);
  assert.equal(parseAdjustmentAmountFils("4.75"), 4750);
  assert.equal(parseAdjustmentAmountFils("4.750"), 4750);
  assert.equal(parseAdjustmentAmountFils("120.00"), 120_000);
  assert.equal(parseAdjustmentAmountFils("0.005"), 5);
  assert.equal(parseAdjustmentAmountFils("-3.50"), -3500);
});

test("a CSV amount with more than three decimals is rejected, not truncated", () => {
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});
