import type { Context } from "koa";
import { verifyBearer } from "../utils/auth-utils";
import { deactivateDeviceToken, upsertDeviceToken } from "../services/push-device";

export default {
  async registerDevice(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? "").trim();
    if (!token) return ctx.badRequest("Token FCM requis");

    const result = await upsertDeviceToken(Number(payload.id), {
      token,
      platform: String(body.platform ?? ""),
      locale: String(body.locale ?? ""),
      appEnv: String(body.appEnv ?? ""),
    });

    if (!result) return ctx.notFound("Compte introuvable");
    ctx.body = { success: true, ...result };
  },

  async unregisterDevice(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? "").trim();
    const result = await deactivateDeviceToken(
      Number(payload.id),
      token.length === 0 ? null : token
    );

    if (!result) return ctx.notFound("Compte introuvable");
    ctx.body = { success: true, ...result };
  },
};
