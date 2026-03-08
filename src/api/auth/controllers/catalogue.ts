import type { Context } from "koa";
import { verifyBearer } from "../utils/auth-utils";

const toAbsoluteUrl = (url?: string | null): string | null => {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const rawBase =
    process.env.STRAPI_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    process.env.STRAPI_URL ||
    `http://localhost:${process.env.PORT || "1337"}`;
  const base = rawBase
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
  return `${base}/${url.replace(/^\/+/, "")}`;
};

const mediaUrl = (media: any): string | null => {
  const raw =
    media?.url ??
    media?.data?.url ??
    (Array.isArray(media?.data) && media.data.length ? media.data[0]?.url : null);
  return toAbsoluteUrl(raw);
};

const auditMeta = (entity: any) => ({
  createdBy: entity?.createdBy
    ? String(entity.createdBy.documentId ?? entity.createdBy.id ?? "")
    : null,
  updatedBy: entity?.updatedBy
    ? String(entity.updatedBy.documentId ?? entity.updatedBy.id ?? "")
    : null,
});

const stripHtml = (raw: string): string => {
  return raw
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

const richTextToPlainText = (raw: unknown): string => {
  if (typeof raw === "string") {
    return stripHtml(raw);
  }

  const walk = (node: unknown): string[] => {
    if (node == null) return [];
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.flatMap(walk);
    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;
      const direct = typeof obj.text === "string" ? [obj.text] : [];
      const children = walk(obj.children);
      return [...direct, ...children];
    }
    return [];
  };

  return walk(raw).join(" ").replace(/\s+/g, " ").trim();
};

export default {
  async list(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const requestedLocale = String((ctx.request.query as any)?.locale ?? "")
      .trim()
      .toLowerCase();
    const locale = requestedLocale === "ar-tn" || requestedLocale === "ar"
      ? "ar-TN"
      : requestedLocale === "fr-fr" || requestedLocale === "fr"
        ? "fr-FR"
        : undefined;

    const buildQuery = (queryLocale?: string): any => {
      const query: any = {
        status: "published",
        sort: ["order:asc", "name:asc"],
        populate: {
          createdBy: true,
          updatedBy: true,
          logo: true,
          products: {
            sort: ["order:asc", "name:asc"],
            filters: { isActive: { $eq: true } },
            populate: { image: true, createdBy: true, updatedBy: true },
          },
        },
      };
      if (queryLocale) query.locale = queryLocale;
      return query;
    };

    const mapCategories = (categories: any[]) =>
      categories
        .map((category) => ({
          id: String(category.documentId ?? category.id ?? ""),
          name: String(category.name ?? "").trim(),
          slug: String(category.slug ?? "").trim(),
          order: Number(category.order ?? 0),
          logoUrl: mediaUrl(category.logo),
          ...auditMeta(category),
          products: ((category.products ?? []) as any[])
            .map((product) => ({
              id: String(product.documentId ?? product.id ?? ""),
              name: String(product.name ?? "").trim(),
              subtitle: String(product.subtitle ?? ""),
              cardShortDescription: String(product.cardShortDescription ?? ""),
              description: richTextToPlainText(product.description),
              viscosity: String(product.viscosity ?? ""),
              reference: String(product.reference ?? ""),
              sku: String(product.sku ?? ""),
              gainVidange: Number(product.gainVidange ?? 0),
              order: Number(product.order ?? 0),
              imageUrl: mediaUrl(product.image),
              ...auditMeta(product),
            }))
            .filter((p) => p.id.length > 0),
        }))
        .filter((c) => c.id.length > 0 && c.name.length > 0);

    const dedupeCategories = (categories: any[]) => {
      const seen = new Set<string>();
      return categories.filter((c) => {
        const key =
          c.slug.length > 0 ? c.slug.toLowerCase() : c.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const loadForLocale = async (queryLocale?: string) => {
      const categories = (await strapi
        .documents("api::category.category")
        .findMany(buildQuery(queryLocale) as any)) as any[];
      return dedupeCategories(mapCategories(categories));
    };

    const hasProducts = (categories: any[]) =>
      categories.some((category) => (category.products?.length ?? 0) > 0);

    let mapped = await loadForLocale(locale);
    // Fallback: if requested locale has no usable products, return default data
    // instead of an empty catalogue.
    if (!hasProducts(mapped) && locale) {
      mapped = await loadForLocale(undefined);
    }

    if (!hasProducts(mapped) && locale === "ar-TN") {
      mapped = await loadForLocale("fr-FR");
    } else if (!hasProducts(mapped) && locale === "fr-FR") {
      mapped = await loadForLocale("ar-TN");
    }
    ctx.body = { categories: mapped };
  },
};
