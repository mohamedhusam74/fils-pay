/**
 * L4-B02 behavior (stdout byte-identical on both revisions):
 * parseAdjustmentCsv is unchanged in the patch but its module was
 * rewritten. Header validation, line splitting, blank-line skipping, reason
 * omission and every error code/message must be identical. Includes the
 * pre-existing thousands-separator case ("1,234.50" splits into amount "1"),
 * which the patch neither fixes nor worsens at this layer.
 */
import { parseAdjustmentCsv } from "../src/admin/adjustmentCsvParsing.js";
import { canonical, out, run } from "./_lib.js";

const M = "11111111-2222-4333-8444-555555555555";
const CASES: ReadonlyArray<[string, string]> = [
  ["lf", `merchantId,amount,reason\n${M},4.75,ok\n${M},-1.25\n`],
  ["crlf", `merchantId,amount,reason\r\n${M},4.75,ok\r\n${M},0\r\n`],
  ["blank-lines", `\n\nmerchantId,amount,reason\n\n${M},1.00,a\n   \n${M},2.00,b\n\n`],
  ["bom-header", `﻿merchantId,amount,reason\n${M},1.00,a\n`],
  ["uppercase-header", `MERCHANTID,AMOUNT,REASON\n${M},1.00,a\n`],
  ["header-extra-column", `merchantId,amount,reason,extra\n${M},1.00,a,b\n`],
  ["two-column-row", `merchantId,amount,reason\n${M},1.00\n`],
  ["four-column-row", `merchantId,amount,reason\n${M},1.00,a,b\n`],
  ["empty-reason", `merchantId,amount,reason\n${M},1.00,\n`],
  ["spaces-in-cells", `merchantId,amount,reason\n  ${M} ,  4.750  , padded reason \n`],
  ["header-only", `merchantId,amount,reason\n`],
  ["whitespace-only", `  \n \r\n `],
  ["bad-header", `id,amount,reason\n${M},1.00,a\n`],
  ["missing-amount", `merchantId,amount,reason\n${M},,a\n`],
  ["missing-merchant", `merchantId,amount,reason\n,1.00,a\n`],
  ["thousands-separator", `merchantId,amount,reason\n${M},1,234.50\n`],
  ["thousands-separator-with-reason", `merchantId,amount,reason\n${M},1,000.500,x\n`],
  ["quoted-amount", `merchantId,amount,reason\n${M},"1,000.500",x\n`],
];

run(() => {
  for (const [name, csv] of CASES) {
    try {
      out(`${name}\t${canonical(parseAdjustmentCsv(csv))}`);
    } catch (err) {
      const e = err as { constructor?: { name?: string }; statusCode?: unknown; code?: unknown; message?: unknown };
      out(`${name}\tthrows\t${canonical({ ctor: e.constructor?.name, statusCode: e.statusCode, code: e.code, message: e.message })}`);
    }
  }
  process.exit(0);
});
