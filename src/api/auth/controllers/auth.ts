import type { Context } from "koa";
import crypto from "crypto";

const otpStorage = new Map<string, any>();

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const generateReferralCode = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = (n: number) =>
    Array.from({ length: n }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `${rand(4)}-${rand(4)}`;
};

const generateUniqueCode = async (): Promise<string> => {
  let code: string;
  let exists: boolean;
  do {
    code = generateReferralCode();
    const found = await strapi.documents("api::account.account").findMany({
      filters: { ownReferralCode: code },
      status: "published",
    });
    exists = found.length > 0;
  } while (exists);
  return code;
};

/** JWT standard { id } */
const issueJwt = (userId: number): string =>
  strapi.plugin("users-permissions").service("jwt").issue({ id: userId });

/** VÃ©rifie le Bearer et retourne le payload, ou null */
const verifyBearer = async (ctx: Context): Promise<any | null> => {
  const authHeader = (ctx.request.headers as any).authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  try {
    return await strapi
      .plugin("users-permissions")
      .service("jwt")
      .verify(authHeader.slice(7));
  } catch {
    return null;
  }
};

/** RÃ©cupÃ¨re le referralReward global depuis le Single Type app-setting */
const getGlobalReferralReward = async (): Promise<number> => {
  try {
    const list = await strapi
      .documents("api::app-setting.app-setting")
      .findMany({ status: "published", limit: 1 } as any);
    return (list[0] as any)?.referralReward ?? 0;
  } catch {
    return 0;
  }
};

// â”€â”€ Controller â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default {
  async sendOtp(ctx: Context) {
    const { phone } = ctx.request.body as any;
    if (!phone) return ctx.badRequest("Phone required");

    const otpCode = "1234"; // TODO: SMS rÃ©el en production
    otpStorage.set(phone, {
      code: otpCode,
      verified: false,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    console.log(`[OTP] ${phone} â†’ ${otpCode}`);
    ctx.body = { success: true, otp: otpCode };
  },

  async verifyOtp(ctx: Context) {
    const { phone, code } = ctx.request.body as any;
    const otp = otpStorage.get(phone);
    if (!otp) return ctx.badRequest("No OTP");
    if (Date.now() > otp.expiresAt) return ctx.badRequest("OTP expirÃ©");
    if (otp.code !== code) return (ctx.body = { valid: false });
    otp.verified = true;
    ctx.body = { valid: true };
  },

  async register(ctx: Context) {
    const {
      email, firstName, lastName, cin, phone,
      governorate, taxId, referralCode,
    } = ctx.request.body as any;

    const otp = otpStorage.get(phone);
    if (!otp || !otp.verified) return ctx.badRequest("Phone not verified");

    const internalPassword = crypto.randomBytes(32).toString("hex");

    const user = await strapi
      .plugin("users-permissions")
      .service("user")
      .add({
        email,
        username: email,
        password: internalPassword,
        confirmed: true,
        blocked: false,
        role: 2,
      });

    const ownReferralCode = await generateUniqueCode();

    // Cherche le parrain si un code a Ã©tÃ© saisi
    let referredByDocumentId: string | undefined;
    if (referralCode) {
      const sponsors = await strapi
        .documents("api::account.account")
        .findMany({
          filters: { ownReferralCode: referralCode },
          status: "published",
        });
      if (sponsors.length > 0) {
        referredByDocumentId = sponsors[0].documentId;
      }
    }

    const account = await strapi
      .documents("api::account.account")
      .create({
        data: {
          userId: user.id,
          firstName, lastName, cin, phone, governorate,
          taxId, referralCode,
          ownReferralCode,
          gains: 0, rank: 0, vidangesCount: 0,
          users_permissions_user: user.documentId,
          ...(referredByDocumentId
            ? { referredBy: referredByDocumentId }
            : {}),
        },
        status: "published",
      });

    const jwt = issueJwt(user.id);
    otpStorage.delete(phone);

    ctx.body = { jwt, user, account };
  },

  async checkCin(ctx: Context) {
    const { cin } = ctx.request.query as any;
    if (!cin) return ctx.badRequest("CIN required");
    const accounts = await strapi
      .documents("api::account.account")
      .findMany({ filters: { cin }, status: "published" });
    ctx.body = { exists: accounts.length > 0 };
  },

  async login(ctx: Context) {
    const { phone } = ctx.request.body as any;
    const otp = otpStorage.get(phone);
    if (!otp || !otp.verified) return ctx.badRequest("Phone not verified");

    const accounts = await strapi
      .documents("api::account.account")
      .findMany({
        filters: { phone },
        status: "published",
        populate: ["users_permissions_user"],
      });

    if (!accounts.length) return ctx.notFound("Account not found");

    const account = accounts[0];
    const linkedUser = account.users_permissions_user as any;
    if (!linkedUser) return ctx.internalServerError("User link missing");

    const user = await strapi
      .plugin("users-permissions")
      .service("user")
      .fetch({ id: linkedUser.id }, {});

    const jwt = issueJwt(user.id);
    otpStorage.delete(phone);

    ctx.body = { jwt, user, account };
  },

  async me(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    // Filtrage par userId (champ entier, fiable pour les nouveaux comptes)
    let accounts = await strapi
      .documents("api::account.account")
      .findMany({
        filters: { userId: { $eq: payload.id } },
        status: "published",
        populate: ["referredAccounts"],
      });

    // Fallback : anciens comptes sans champ userId â€” requÃªte directe en DB
    if (!accounts.length) {
      const dbResults = await (strapi.db as any)
        .query("api::account.account")
        .findMany({
          where: { users_permissions_user: { id: payload.id } },
        });
      if (dbResults.length) {
        // Backfill userId sur le premier compte trouvÃ©
        const docId: string =
          dbResults[0].document_id ?? dbResults[0].documentId;
        if (docId) {
          await strapi.documents("api::account.account").update({
            documentId: docId,
            data: { userId: payload.id } as any,
          });
        }
        // Recharge via Document Service aprÃ¨s backfill
        accounts = await strapi
          .documents("api::account.account")
          .findMany({
            filters: { userId: { $eq: payload.id } },
            status: "published",
            populate: ["referredAccounts"],
          });
      }
    }

    if (!accounts.length) return ctx.notFound("Compte introuvable");

    const referralReward = await getGlobalReferralReward();

    ctx.body = {
      account: accounts[0],
      referralReward,
    };
  },
  async updateMe(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized('Token invalide ou manquant');

    const body = (ctx.request.body ?? {}) as any;
    const data: any = {};

    if (typeof body.garageName === 'string') data.garageName = body.garageName;
    if (typeof body.address === 'string') data.address = body.address;
    if (typeof body.birthDate === 'string') data.birthDate = body.birthDate;
    if (typeof body.postalCode === 'string') data.postalCode = body.postalCode;
    if (typeof body.profileImagePath === 'string') data.profileImagePath = body.profileImagePath;
    if (typeof body.profileImageUrl === 'string') data.profileImageUrl = body.profileImageUrl;
    if (typeof body.profileImageUrl === 'string' && !data.profileImagePath) {
      data.profileImagePath = body.profileImageUrl;
    }

    let accounts = await strapi.documents('api::account.account').findMany({
      filters: { userId: { $eq: payload.id } },
      status: 'published',
      limit: 1,
    } as any);

    if (!accounts.length) {
      return ctx.notFound('Compte introuvable');
    }

    const updated = await strapi.documents('api::account.account').update({
      documentId: accounts[0].documentId,
      data,
      status: 'published',
    } as any);

    const referralReward = await getGlobalReferralReward();

    ctx.body = {
      account: updated,
      referralReward,
    };
  },
};
