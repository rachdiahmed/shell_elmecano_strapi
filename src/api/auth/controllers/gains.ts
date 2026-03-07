import type { Context } from "koa";
import { verifyBearer } from "../utils/auth-utils";

type GainOrderStatus =
  | "validating"
  | "processing"
  | "shipping"
  | "delivered"
  | "cancelled";

const CLAIM_STEP = 10;

const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const isMultipleOfStep = (value: number): boolean => {
  const quotient = value / CLAIM_STEP;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
};

const normalizeOrder = (order: any) => ({
  id: order?.documentId ?? order?.id ?? "",
  code: String(order?.code ?? ""),
  title: String(order?.title ?? "Chèque Cadeaux"),
  amount: toNumber(order?.amount),
  orderStatus: String(order?.orderStatus ?? "validating") as GainOrderStatus,
  requestedAt: order?.requestedAt ?? order?.createdAt ?? null,
  deliveredAt: order?.deliveredAt ?? null,
  createdBy: order?.createdBy
    ? String(order.createdBy.documentId ?? order.createdBy.id ?? "")
    : null,
  updatedBy: order?.updatedBy
    ? String(order.updatedBy.documentId ?? order.updatedBy.id ?? "")
    : null,
});

const buildOrderCode = (): string => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rand = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `#${rand(4)}-${rand(4)}`;
};

const findAccountForUser = async (userId: number) => {
  const accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    status: "published",
    limit: 1,
  } as any);
  return accounts.length ? (accounts[0] as any) : null;
};

const buildOverview = async (account: any) => {
  const balance = round3(toNumber(account?.gains));
  const claimableAmount = Math.floor(balance / CLAIM_STEP) * CLAIM_STEP;

  const nonDelivered = await strapi.documents("api::gain-order.gain-order").findMany({
    filters: {
      account: { documentId: { $eq: account.documentId } },
      orderStatus: { $in: ["validating", "processing", "shipping"] },
    },
    sort: ["requestedAt:desc", "createdAt:desc"],
    status: "published",
    populate: ["createdBy", "updatedBy"],
    limit: 1,
  } as any);

  const historyOrders = await strapi.documents("api::gain-order.gain-order").findMany({
    filters: {
      account: { documentId: { $eq: account.documentId } },
      orderStatus: { $in: ["delivered", "cancelled"] },
    },
    sort: ["deliveredAt:desc", "requestedAt:desc", "createdAt:desc"],
    status: "published",
    populate: ["createdBy", "updatedBy"],
    limit: 25,
  } as any);

  const hasActiveOrder = nonDelivered.length > 0;

  return {
    balance,
    claimStep: CLAIM_STEP,
    claimableAmount,
    hasActiveOrder,
    canClaim: claimableAmount >= CLAIM_STEP && !hasActiveOrder,
    activeOrder: hasActiveOrder ? normalizeOrder(nonDelivered[0]) : null,
    history: historyOrders.map(normalizeOrder),
  };
};

export default {
  async overview(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("Compte introuvable");

    ctx.body = await buildOverview(account);
  },

  async claim(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("Compte introuvable");

    const existingActiveOrder = await strapi.documents("api::gain-order.gain-order").findMany({
      filters: {
        account: { documentId: { $eq: account.documentId } },
        orderStatus: { $in: ["validating", "processing", "shipping"] },
      },
      sort: ["requestedAt:desc", "createdAt:desc"],
      status: "published",
      limit: 1,
    } as any);
    if (existingActiveOrder.length > 0) {
      return ctx.conflict("Active order exists");
    }

    const balance = round3(toNumber(account.gains));
    const maxClaimable = Math.floor(balance / CLAIM_STEP) * CLAIM_STEP;
    if (maxClaimable < CLAIM_STEP) {
      return ctx.badRequest("Insufficient claimable balance");
    }

    const rawAmount = (ctx.request.body as any)?.amount;
    const requested = rawAmount == null ? maxClaimable : toNumber(rawAmount);
    if (!Number.isFinite(requested) || requested <= 0) {
      return ctx.badRequest("Invalid amount");
    }
    if (!isMultipleOfStep(requested)) {
      return ctx.badRequest("Amount must be multiple of 10");
    }
    if (requested > maxClaimable || requested > balance) {
      return ctx.badRequest("Amount exceeds balance");
    }

    const code = buildOrderCode();
    const nowIso = new Date().toISOString();

    await strapi.documents("api::gain-order.gain-order").create({
      data: {
        code,
        title: "Chèque Cadeaux",
        amount: requested,
        orderStatus: "validating",
        requestedAt: nowIso,
        account: account.documentId,
      },
      status: "published",
    } as any);

    await strapi.documents("api::account.account").update({
      documentId: account.documentId,
      data: { gains: round3(balance - requested) } as any,
      status: "published",
    } as any);

    const refreshed = await findAccountForUser(payload.id as number);
    if (!refreshed) return ctx.notFound("Compte introuvable");

    ctx.body = await buildOverview(refreshed);
  },
};
