import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/** Rows read per query; bounds an export's memory whatever its date range. */
export const EXPORT_PAGE_SIZE = 1000;

/**
 * Yields the CSV for `GET /v1/transactions/export` one page at a time: the
 * header, then one chunk per page, each row prefixed with "\n". Pages use an
 * (occurred_at, id) keyset so rows sharing a timestamp across a page boundary
 * are neither skipped nor repeated; the cursor timestamp round-trips as text
 * because a JS Date would drop its microseconds.
 */
export async function* transactionsExportCsvChunks(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield "id,status,amount_bhd,captured_bhd,reference,occurred_at";

  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAt: string; id: string } | null = null;

  for (;;) {
    const result: { rows: Array<TransactionRow & { cursor_occurred_at: string }> } = await pool.query(
      `SELECT *, occurred_at::text AS cursor_occurred_at FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAt ?? null,
        cursor?.id ?? null,
        EXPORT_PAGE_SIZE,
      ],
    );

    if (result.rows.length > 0) {
      yield result.rows.map((row) => "\n" + toCsvRow(row)).join("");
    }
    if (result.rows.length < EXPORT_PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAt: last.cursor_occurred_at, id: last.id };
  }
}

/** The whole export as one string, for small exports and tests. */
export async function buildTransactionsExportCsv(
  pool: Pool,
  filters: TransactionsExportFilters,
): Promise<string> {
  let csv = "";
  for await (const chunk of transactionsExportCsvChunks(pool, filters)) {
    csv += chunk;
  }
  return csv;
}