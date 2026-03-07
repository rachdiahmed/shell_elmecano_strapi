import type { Context } from "koa";
import crypto from "crypto";
import {
  generateUniqueOwnReferralCode,
  getAuthenticatedRoleId,
  issueJwt,
  normalizeOwnReferralCode,
  normalizePhone,
} from "../utils/auth-utils";

export default {
  async register(ctx: Context) {
    const {
      email,
      firstName,
      lastName,
      cin,
      phone,
      governorate,
      taxId,
      ownReferralCode: sponsorOwnReferralCode,
      wantNewsletterSubscription,
    } = ctx.request.body as any;

    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!normalizedEmail) return ctx.badRequest("Email required");

    const existingUsers = await strapi
      .query("plugin::users-permissions.user")
      .findMany({
        where: {
          $or: [
            { email: { $eqi: normalizedEmail } },
            { username: { $eqi: normalizedEmail } },
          ],
        },
        limit: 1,
      } as any);
    if (existingUsers?.length) return ctx.conflict("Email deja utilise");

    const normalizedPhone = normalizePhone(phone);
    const normalizedReferralCode =
      normalizeOwnReferralCode(sponsorOwnReferralCode);
    if (
      normalizedReferralCode.length > 0 &&
      normalizedReferralCode.length !== 9
    ) {
      return ctx.badRequest("Referral code invalid");
    }

    if (!strapi.service("api::auth.otp-store").isVerified(normalizedPhone)) {
      return ctx.badRequest("Phone not verified");
    }

    const internalPassword = crypto.randomBytes(32).toString("hex");
    const authenticatedRoleId = await getAuthenticatedRoleId();

    const user = await strapi
      .plugin("users-permissions")
      .service("user")
      .add({
        email: normalizedEmail,
        username: normalizedEmail,
        password: internalPassword,
        confirmed: true,
        blocked: false,
        role: authenticatedRoleId,
      });

    const ownReferralCode = await generateUniqueOwnReferralCode();

    let referredByDocumentId: string | undefined;
    if (normalizedReferralCode) {
      const sponsor = await strapi
        .service("api::auth.referral")
        .findSponsorByOwnReferralCode(normalizedReferralCode);
      if (!sponsor) return ctx.badRequest("Referral code invalid");
      referredByDocumentId = sponsor.documentId;
    }

    const account = await strapi.documents("api::account.account").create({
      data: {
        userId: user.id,
        firstName,
        lastName,
        cin,
        phone: normalizedPhone,
        governorate,
        taxId,
        ownReferralCode,
        wantNewsletterSubscription: !!wantNewsletterSubscription,
        hasCompletedProfile: false,
        gains: 0,
        rank: 0,
        vidangesCount: 0,
        users_permissions_user: user.documentId,
        ...(referredByDocumentId ? { referredBy: referredByDocumentId } : {}),
      },
      status: "published",
    });

    if (referredByDocumentId) {
      await strapi
        .service("api::auth.referral")
        .applyReferralForNewAccount(referredByDocumentId);
    }

    const jwt = issueJwt(user.id);
    strapi.service("api::auth.otp-store").clear(normalizedPhone);

    ctx.body = { jwt, user, account };
  },

  async checkCin(ctx: Context) {
    const cin = String((ctx.request.query as any)?.cin ?? "").trim();
    if (!cin) return ctx.badRequest("CIN required");

    const accounts = await strapi.documents("api::account.account").findMany({
      filters: { cin },
      status: "published",
      limit: 1,
    } as any);

    ctx.body = { exists: accounts.length > 0 };
  },

  async checkEmail(ctx: Context) {
    const email = String((ctx.request.query as any)?.email ?? "")
      .trim()
      .toLowerCase();
    if (!email) return ctx.badRequest("Email required");

    const users = await strapi
      .query("plugin::users-permissions.user")
      .findMany({
        where: {
          $or: [{ email: { $eqi: email } }, { username: { $eqi: email } }],
        },
        limit: 1,
      } as any);

    ctx.body = { exists: (users?.length ?? 0) > 0 };
  },

  async checkReferralCode(ctx: Context) {
    const code = normalizeOwnReferralCode((ctx.request.query as any)?.code);
    if (!code || code.length !== 9) {
      return ctx.badRequest("Referral code required");
    }

    const accounts = await strapi.documents("api::account.account").findMany({
      filters: { ownReferralCode: code },
      status: "published",
      limit: 1,
    } as any);

    ctx.body = { exists: accounts.length > 0 };
  },
};
