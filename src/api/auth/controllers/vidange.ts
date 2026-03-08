import type { Context } from "koa";
import { verifyBearer } from "../utils/auth-utils";

const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const normalizeCode = (value: unknown): string =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const normalizeLot = (value: unknown): string =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .trim();

const buildImageUrl = (url: string | null): string | null => {
  if (!url || !url.trim()) return null;
  const raw = url.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const base = String(process.env.STRAPI_PUBLIC_URL ?? "").trim();
  if (!base) return raw;
  return `${base.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
};

const findAccountForUser = async (userId: number) => {
  const list = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    fields: ["gains", "vidangesCount"] as any,
    status: "published",
    limit: 1,
  } as any);
  return list.length ? (list[0] as any) : null;
};

export default {
  async metadata(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const settings = (await strapi.documents("api::app-setting.app-setting").findFirst({
      fields: ["vidangeHelpVideoUrl"] as any,
      populate: {
        vidangeHelpImage: {
          fields: ["url"] as any,
        },
      },
      status: "published",
    } as any)) as any;

    const imageUrl = buildImageUrl(settings?.vidangeHelpImage?.url ?? null);
    ctx.body = {
      helpVideoUrl: String(settings?.vidangeHelpVideoUrl ?? "").trim() || null,
      helpImageUrl: imageUrl,
    };
  },

  async consume(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const uniqueCode = normalizeCode((ctx.request.body as any)?.uniqueCode);
    const lotNumber = normalizeLot((ctx.request.body as any)?.lotNumber);
    if (uniqueCode.length != 12) {
      return ctx.badRequest("Code unique invalide (12 caracteres requis)");
    }
    if (lotNumber.length < 4) {
      return ctx.badRequest("Numero du lot invalide");
    }

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("Compte introuvable");

    const lots = (await strapi.documents("api::lot-test.lot-test").findMany({
      filters: {
        uniqueCode: { $eq: uniqueCode },
        lotNumber: { $eq: lotNumber },
        isActive: { $eq: true },
        isConsumed: { $eq: false },
      } as any,
      populate: {
        product: {
          fields: ["name", "gainVidange"] as any,
        },
      },
      status: "published",
      limit: 1,
    } as any)) as any[];

    if (lots.length === 0) {
      return ctx.badRequest("Code ou numero du lot invalide");
    }

    const lot = lots[0];
    const product = lot?.product;
    if (!product?.documentId) {
      return ctx.badRequest("Produit non attribue a ce lot");
    }

    const gain = round3(toNumber(product.gainVidange));
    const nowIso = new Date().toISOString();

    await strapi.documents("api::vidange.vidange").create({
      data: {
        uniqueCode,
        lotNumber,
        consumedAt: nowIso,
        gainAwarded: gain,
        product: product.documentId,
        account: account.documentId,
      } as any,
      status: "published",
    } as any);

    await strapi.documents("api::lot-test.lot-test").update({
      documentId: lot.documentId,
      data: {
        isConsumed: true,
        consumedAt: nowIso,
        consumedByAccount: account.documentId,
      } as any,
      status: "published",
    } as any);

    const currentGains = round3(toNumber(account.gains));
    const currentVidanges = Math.max(0, Math.floor(toNumber(account.vidangesCount)));
    const nextGains = round3(currentGains + gain);
    const nextVidanges = currentVidanges + 1;

    await strapi.documents("api::account.account").update({
      documentId: account.documentId,
      data: {
        gains: nextGains,
        vidangesCount: nextVidanges,
      } as any,
      status: "published",
    } as any);

    ctx.body = {
      success: true,
      consumedAt: nowIso,
      gainAwarded: gain,
      product: {
        id: String(product.documentId),
        name: String(product.name ?? ""),
      },
      totals: {
        gains: nextGains,
        vidangesCount: nextVidanges,
      },
    };
  },
};
