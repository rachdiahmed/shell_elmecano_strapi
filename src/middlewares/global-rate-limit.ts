type Bucket = {
  count: number;
  resetAt: number;
};

const store = new Map<string, Bucket>();

export default (_config: unknown, _ctx: { strapi: any }) => {
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const max = Number(process.env.RATE_LIMIT_MAX ?? 120);

  return async (ctx: any, next: () => Promise<void>) => {
    if (!String(ctx.path ?? "").startsWith("/api")) {
      await next();
      return;
    }

    const ip =
      String(ctx.request.ip ?? "").trim() ||
      String(ctx.ip ?? "").trim() ||
      String(ctx.request.headers["x-forwarded-for"] ?? "")
        .split(",")[0]
        .trim() ||
      "unknown";

    const now = Date.now();
    const key = ip;
    const current = store.get(key);

    if (!current || now >= current.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      current.count += 1;
      if (current.count > max) {
        const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
        ctx.set("Retry-After", String(retryAfterSec));
        ctx.status = 429;
        ctx.body = { error: "Too many requests. Please try again later." };
        return;
      }
    }

    if (store.size > 20000) {
      for (const [k, v] of store.entries()) {
        if (now >= v.resetAt) store.delete(k);
      }
    }

    await next();
  };
};
