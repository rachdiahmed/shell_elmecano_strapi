import type { Context } from "koa";
import { issueJwt, normalizePhone } from "../utils/auth-utils";

export default {
  async checkPhone(ctx: Context) {
    const phone = normalizePhone((ctx.request.query as any)?.phone);
    if (!phone) return ctx.badRequest("Phone required");

    const accounts = await strapi.documents("api::account.account").findMany({
      filters: { phone },
      status: "published",
      limit: 1,
    } as any);

    ctx.body = { exists: accounts.length > 0 };
  },

  async send(ctx: Context) {
    const phone = normalizePhone((ctx.request.body as any)?.phone);
    if (!phone) return ctx.badRequest("Phone required");

    const otpCode = strapi.service("api::auth.otp-store").send(phone);
    console.log(`[OTP] ${phone} -> ${otpCode}`);
    ctx.body = { success: true, otp: otpCode };
  },

  async verify(ctx: Context) {
    const phone = normalizePhone((ctx.request.body as any)?.phone);
    const code = String((ctx.request.body as any)?.code ?? "");
    if (!phone) return ctx.badRequest("Phone required");
    if (!code) return ctx.badRequest("Code required");

    const result = strapi.service("api::auth.otp-store").verify(phone, code);
    if (!result.valid) {
      if (result.reason === "not_found") return ctx.badRequest("No OTP");
      if (result.reason === "expired") return ctx.badRequest("OTP expired");
      return (ctx.body = { valid: false });
    }

    ctx.body = { valid: true };
  },

  async login(ctx: Context) {
    const phone = normalizePhone((ctx.request.body as any)?.phone);
    if (!phone) return ctx.badRequest("Phone required");
    if (!strapi.service("api::auth.otp-store").isVerified(phone)) {
      return ctx.badRequest("Phone not verified");
    }

    const accounts = await strapi.documents("api::account.account").findMany({
      filters: { phone },
      status: "published",
      populate: ["users_permissions_user"],
      limit: 1,
    } as any);

    if (!accounts.length) return ctx.notFound("Account not found");

    const account = accounts[0] as any;
    const linkedUser = account.users_permissions_user as any;
    const userId = Number(account.userId ?? linkedUser?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return ctx.internalServerError("User link missing");
    }

    const user = await strapi.query("plugin::users-permissions.user").findOne({
      where: { id: userId },
    } as any);
    if (!user) return ctx.notFound("User not found");

    const jwt = issueJwt(user.id);
    strapi.service("api::auth.otp-store").clear(phone);

    ctx.body = { jwt, user, account };
  },
};
