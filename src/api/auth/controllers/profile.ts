import type { Context } from "koa";
import {
  computeHasCompletedProfile,
  getGlobalReferralReward,
  normalizeAccount,
  normalizeOwnReferralCode,
  verifyBearer,
} from "../utils/auth-utils";

const findAccountForUser = async (userId: number) => {
  let accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    status: "published",
    populate: ["referredAccounts", "profileImage", "createdBy", "updatedBy"],
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
    populate: ["referredAccounts", "profileImage", "createdBy", "updatedBy"],
    limit: 1,
  } as any);

  return accounts.length ? (accounts[0] as any) : null;
};

const toNumber = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const isValidAddressFormat = (value: string): boolean => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return true;
  return /^(?=.{5,120}$)(?=.*[A-Za-zÀ-ÖØ-öø-ÿ])[A-Za-zÀ-ÖØ-öø-ÿ0-9\s,'./-]+$/.test(
    trimmed
  );
};

const withAuditMeta = (entity: any) => ({
  createdBy: entity?.createdBy
    ? String(entity.createdBy.documentId ?? entity.createdBy.id ?? "")
    : null,
  updatedBy: entity?.updatedBy
    ? String(entity.updatedBy.documentId ?? entity.updatedBy.id ?? "")
    : null,
});

const ensureProfileImageLinked = async (
  accountDocumentId: string,
  accountEntityId: number | null,
  profileImageId: number
) => {
  // Try with documents API (direct id form)
  try {
    await strapi.documents("api::account.account").update({
      documentId: accountDocumentId,
      data: { profileImage: profileImageId } as any,
      status: "published",
    } as any);
    return;
  } catch {}

  // Try with documents API (connect form)
  try {
    await strapi.documents("api::account.account").update({
      documentId: accountDocumentId,
      data: { profileImage: { connect: [profileImageId] } } as any,
      status: "published",
    } as any);
    return;
  } catch {}

  // Final fallback with entityService by numeric entity id.
  if (accountEntityId != null && Number.isFinite(accountEntityId)) {
    try {
      await strapi.entityService.update("api::account.account", accountEntityId, {
        data: { profileImage: profileImageId } as any,
      });
      return;
    } catch {}
  }

  throw new Error("Impossible de lier l'image de profil au compte");
};

const ensureUserUploadFolder = async (accountDocumentId: string) => {
  const apiUploadFolder = await strapi
    .plugin("upload")
    .service("api-upload-folder")
    .getAPIUploadFolder();
  const folderService = strapi.plugin("upload").service("folder");
  const parentId = Number(apiUploadFolder?.id ?? 0) || null;
  const name = String(accountDocumentId ?? "").trim();
  if (!name) throw new Error("Account documentId manquant");

  const exists = await folderService.exists({
    name,
    parent: parentId,
  });
  if (!exists) {
    const created = await folderService.create({
      name,
      parent: parentId,
    });
    return created;
  }

  const found = await strapi.db.query("plugin::upload.folder").findOne({
    where: {
      name,
      parent: parentId,
    },
  });
  return found;
};

export default {
  async uploadFolder(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("AUTH_TOKEN_INVALID");

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("VIDANGE_ACCOUNT_NOT_FOUND");

    const folder = await ensureUserUploadFolder(String(account.documentId ?? ""));
    ctx.body = {
      folderId: Number(folder?.id ?? 0) || null,
      folderName: String(folder?.name ?? ""),
    };
  },

  async me(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const account = await findAccountForUser(payload.id as number);
    if (!account) return ctx.notFound("Compte introuvable");

    const referralReward = await getGlobalReferralReward();
    ctx.body = {
      account: { ...normalizeAccount(account), ...withAuditMeta(account) },
      referralReward,
    };
  },

  async updateMe(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const body = (ctx.request.body ?? {}) as any;
    const data: any = {};

    if (typeof body.garageName === "string") data.garageName = body.garageName;
    if (typeof body.address === "string") {
      if (!isValidAddressFormat(body.address)) {
        return ctx.badRequest("PROFILE_INVALID_ADDRESS_FORMAT");
      }
      data.address = body.address.trim();
    }
    if (typeof body.birthDate === "string") data.birthDate = body.birthDate;
    if (typeof body.postalCode === "string") data.postalCode = body.postalCode;

    const parsedProfileImageId =
      typeof body.profileImageId === "number"
        ? body.profileImageId
        : Number.parseInt(body.profileImageId, 10);
    const profileImageId = Number.isFinite(parsedProfileImageId)
      ? parsedProfileImageId
      : null;

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
    const wasCompleted = current.hasCompletedProfile === true;
    const isNowCompleted = computeHasCompletedProfile(nextSnapshot);
    data.hasCompletedProfile = isNowCompleted;

    // Credit profile completion reward once when crossing from incomplete -> complete.
    if (!wasCompleted && isNowCompleted) {
      data.gains = toNumber(current.gains) + 1;
    }

    await strapi.documents("api::account.account").update({
      documentId: current.documentId,
      data,
      status: "published",
    } as any);

    if (profileImageId != null) {
      await ensureProfileImageLinked(
        String(current.documentId ?? ""),
        Number.isFinite(Number(current.id)) ? Number(current.id) : null,
        profileImageId
      );
      try {
        const folder = await ensureUserUploadFolder(String(current.documentId ?? ""));
        const folderId = Number(folder?.id ?? 0) || null;
        if (folderId != null) {
          await strapi
            .plugin("upload")
            .service("upload")
            .updateFileInfo(profileImageId, { folder: folderId });
        }
      } catch {}
    }

    const refreshed = await strapi.documents("api::account.account").findOne({
      documentId: current.documentId,
      status: "published",
      populate: ["profileImage", "createdBy", "updatedBy"],
    } as any);

    const referralReward = await getGlobalReferralReward();
    ctx.body = {
      account: { ...normalizeAccount(refreshed), ...withAuditMeta(refreshed) },
      referralReward,
    };
  },

  async applyReferralCode(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const code = normalizeOwnReferralCode((ctx.request.body as any)?.ownReferralCode);
    if (!code || code.length !== 9) {
      return ctx.badRequest("Referral code invalid");
    }

    const current = await findAccountForUser(payload.id as number);
    if (!current) return ctx.notFound("Compte introuvable");

    if (current.referredBy) {
      return ctx.conflict("Referral already used");
    }

    if (String(current.ownReferralCode ?? "").toUpperCase() === code) {
      return ctx.badRequest("Cannot use own referral code");
    }

    const sponsor = await strapi
      .service("api::auth.referral")
      .findSponsorByOwnReferralCode(code);
    if (!sponsor) return ctx.badRequest("Referral code invalid");

    if (String(sponsor.documentId ?? "") === String(current.documentId ?? "")) {
      return ctx.badRequest("Cannot use own referral code");
    }

    await strapi.documents("api::account.account").update({
      documentId: current.documentId,
      data: {
        referredBy: sponsor.documentId,
      } as any,
      status: "published",
    } as any);

    const referralService = strapi.service("api::auth.referral");
    await referralService.applyReferralForNewAccount(sponsor.documentId);
    await referralService.notifySponsorReferralUsed(
      sponsor.documentId,
      `${current.firstName ?? ""} ${current.lastName ?? ""}`.trim()
    );

    const refreshed = await strapi.documents("api::account.account").findOne({
      documentId: current.documentId,
      status: "published",
      populate: ["profileImage", "referredBy", "createdBy", "updatedBy"],
    } as any);

    const referralReward = await getGlobalReferralReward();
    ctx.body = {
      account: { ...normalizeAccount(refreshed), ...withAuditMeta(refreshed) },
      referralReward,
    };
  },
};
