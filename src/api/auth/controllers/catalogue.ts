import type { Context } from "koa";

const toAbsoluteUrl = (url?: string | null): string | null => {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const serverUrl =
    process.env.PUBLIC_URL ||
    process.env.STRAPI_URL ||
    `http://localhost:${process.env.PORT || "1337"}`;
  return `${serverUrl.replace(/\/$/, "")}${url}`;
};

const mediaUrl = (media: any): string | null => {
  const raw =
    media?.url ??
    media?.data?.url ??
    (Array.isArray(media?.data) && media.data.length ? media.data[0]?.url : null);
  return toAbsoluteUrl(raw);
};

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
    const requestedLocale = String((ctx.request.query as any)?.locale ?? "")
      .trim()
      .toLowerCase();
    const locale = requestedLocale === "ar-tn" || requestedLocale === "ar"
      ? "ar-TN"
      : requestedLocale === "fr-fr" || requestedLocale === "fr"
        ? "fr-FR"
        : undefined;

    const query: any = {
      status: "published",
      sort: ["order:asc", "name:asc"],
      populate: {
        logo: true,
        products: {
          sort: ["order:asc", "name:asc"],
          filters: { isActive: { $eq: true } },
          populate: { image: true },
        },
      },
    };
    if (locale) query.locale = locale;

    const categories = (await strapi
      .documents("api::category.category")
      .findMany(query as any)) as any[];

    ctx.body = {
      categories: categories.map((category) => ({
        id: String(category.documentId ?? category.id ?? ""),
        name: String(category.name ?? ""),
        slug: String(category.slug ?? ""),
        order: Number(category.order ?? 0),
        logoUrl: mediaUrl(category.logo),
        products: ((category.products ?? []) as any[]).map((product) => ({
          id: String(product.documentId ?? product.id ?? ""),
          name: String(product.name ?? ""),
          subtitle: String(product.subtitle ?? ""),
          cardShortDescription: String(product.cardShortDescription ?? ""),
          description: richTextToPlainText(product.description),
          viscosity: String(product.viscosity ?? ""),
          reference: String(product.reference ?? ""),
          sku: String(product.sku ?? ""),
          gainVidange: Number(product.gainVidange ?? 0),
          order: Number(product.order ?? 0),
          imageUrl: mediaUrl(product.image),
        })),
      })),
    };
  },
};
