import type { Context } from "koa";
import {
  computeHasCompletedProfile,
  getGlobalReferralReward,
  normalizeAccount,
  verifyBearer,
} from "../utils/auth-utils";

const findAccountForUser = async (userId: number) => {
  let accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    status: "published",
    populate: ["referredAccounts", "profileImage"],
    limit: 1,
  } as any);

  if (accounts.length) return accounts[0] as any;

  const dbResults = await (strapi.db as any)
    .query("api::account.account")
    .findMany({
      where: { users_permissions_user: { id: userId } },
      limit: 1,
    });

  if (!dbResults.length) return null;

  const docId: string = dbResults[0].document_id ?? dbResults[0].documentId;
  if (docId) {
    await strapi.documents("api::account.account").update({
      documentId: docId,
      data: { userId } as any,
    });
  }

  accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    status: "published",
    populate: ["referredAccounts", "profileImage"],
    limit: 1,
  } as any);

  return accounts.length ? (accounts[0] as any) : null;
};

export default {
  async me(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("Compte introuvable");

    const referralReward = await getGlobalReferralReward();
    ctx.body = {
      account: normalizeAccount(account),
      referralReward,
    };
  },

  async updateMe(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const body = (ctx.request.body ?? {}) as any;
    const data: any = {};

    if (typeof body.garageName === "string") data.garageName = body.garageName;
    if (typeof body.address === "string") data.address = body.address;
    if (typeof body.birthDate === "string") data.birthDate = body.birthDate;
    if (typeof body.postalCode === "string") data.postalCode = body.postalCode;

    const profileImageId =
      typeof body.profileImageId === "number"
        ? body.profileImageId
        : Number.parseInt(body.profileImageId, 10);
    if (Number.isFinite(profileImageId)) data.profileImage = profileImageId;

    const current = await findAccountForUser(payload.id as number);
    if (!current) return ctx.notFound("Compte introuvable");

    const nextSnapshot = {
      garageName:
        data.garageName !== undefined ? data.garageName : current.garageName,
      address: data.address !== undefined ? data.address : current.address,
      birthDate:
        data.birthDate !== undefined ? data.birthDate : current.birthDate,
      postalCode:
        data.postalCode !== undefined ? data.postalCode : current.postalCode,
    };
    data.hasCompletedProfile = computeHasCompletedProfile(nextSnapshot);

    await strapi.documents("api::account.account").update({
      documentId: current.documentId,
      data,
      status: "published",
    } as any);

    const refreshed = await strapi.documents("api::account.account").findOne({
      documentId: current.documentId,
      status: "published",
      populate: ["profileImage"],
    } as any);

    const referralReward = await getGlobalReferralReward();
    ctx.body = {
      account: normalizeAccount(refreshed),
      referralReward,
    };
  },
};
