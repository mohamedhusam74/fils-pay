/**
 * L4-S02 security (must pass on both revisions): the parser swap must not
 * widen what is accepted or change how rejection fails. Over a fixed-seed
 * corpus (grammar corpus seed 0x4C340002, 20000 cases, plus 20000 strings
 * from a hostile alphabet: signs, separators, exponent/hex markers,
 * Unicode spaces, Arabic-Indic and fullwidth digits, BOM, NBSP) and the
 * fixed edges: every accepted input is a plain ASCII decimal after trim and
 * yields a safe integer; every rejection is the AppError
 * BadRequestError/400/invalid_amount (never a raw RangeError -> 500).
 */
import { parseAdjustmentAmountFils } from "../src/admin/adjustmentCsvParsing.js";
import { amountCorpus, attempt, diag, EDGE_INPUTS, finish, mulberry32, run } from "./_lib.js";

const ALPHABET = [
  ..."0123456789", "-", "+", ".", ",", "e", "E", "x", "_", " ", "\t", " ", " ", " ", "﻿", "−",
  ..."٠١٢٣٤٥٦٧٨٩", ..."０１２３４５６７８９", "Infinity", "NaN", "0x",
];

run(() => {
  const rnd = mulberry32(0x4c340003);
  const hostile = Array.from({ length: 20_000 }, () => {
    const len = 1 + Math.floor(rnd() * 12);
    return Array.from({ length: len }, () => ALPHABET[Math.floor(rnd() * ALPHABET.length)] as string).join("");
  });
  const inputs = [...amountCorpus(0x4c340002, 20_000).map((c) => c.input), ...hostile, ...EDGE_INPUTS];
  const failures: string[] = [];
  let accepted = 0;
  for (const input of inputs) {
    const o = attempt(parseAdjustmentAmountFils, input);
    if (o.ok) {
      accepted++;
      if (!/^-?\d+(\.\d+)?$/.test(input.trim())) failures.push(`${JSON.stringify(input)} accepted (${o.value}) but is not a plain ASCII decimal`);
      if (!Number.isSafeInteger(o.value)) failures.push(`${JSON.stringify(input)} accepted as non-safe ${o.value}`);
    } else if (o.ctor !== "BadRequestError" || o.statusCode !== 400 || o.code !== "invalid_amount") {
      failures.push(`${JSON.stringify(input)} rejected with ${o.ctor}/${String(o.statusCode)}/${String(o.code)} instead of BadRequestError/400/invalid_amount`);
    }
  }
  diag(`inputs ${inputs.length}, accepted ${accepted}, failures ${failures.length}`);
  for (const f of failures.slice(0, 20)) diag(`  ${f}`);
  finish(failures.length ? [`${failures.length} failures; first: ${failures[0]}`] : []);
});
