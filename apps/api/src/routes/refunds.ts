import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

/** Same contract as routes/transactions.ts: required, scoped per merchant + endpoint. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

interface ParsedRefundBody {
  transactionId: string;
  amountFils?: number;
  reason?: string;
}

function parseRefundBody(body: RefundBody | undefined): ParsedRefundBody {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
  }
  if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils))) {
    throw new BadRequestError("invalid_request", "amountFils must be an integer number of fils");
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON_LENGTH)) {
    throw new BadRequestError("invalid_request", `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`);
  }
  return { transactionId, amountFils, reason: reason?.trim() };
}

/**
 * `POST /v1/refunds` — full (amountFils omitted) or partial refund of a
 * captured transaction. Registered with prefix '/v1/refunds'.
 *
 * Auth: an API key, or a merchant session with role owner or finance. An
 * admin impersonation grant is refused even when it maps to `owner`:
 * refunds move money, and the write-attribution columns cannot record an
 * operator. The merchant always comes from the authenticated context.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      if (auth.actorType === "admin_impersonation") {
        throw new ForbiddenError("impersonation_read_only");
      }
      const idempotencyKey = getIdempotencyKey(request);
      const body = parseRefundBody(request.body);

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId: body.transactionId,
        amountFils: body.amountFils === undefined ? undefined : toFils(body.amountFils, { allowNegative: true }),
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason: body.reason,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
