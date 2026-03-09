import type { Context } from "koa";
import { getBearerToken, verifyBearer } from "../utils/auth-utils";
import { deactivateDeviceToken } from "../services/push-device";
import { revokeToken } from "../services/token-revocation";

export default {
  async logout(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const token = getBearerToken(ctx);
    if (!token) return ctx.unauthorized("Token invalide ou manquant");

    const exp = typeof payload.exp === "number" ? payload.exp : undefined;
    revokeToken(token, exp);
    await deactivateDeviceToken(Number(payload.id), null);

    ctx.body = {
      success: true,
      message: "Déconnexion effectuée",
    };
  },
};
