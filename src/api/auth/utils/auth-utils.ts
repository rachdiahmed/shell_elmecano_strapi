import type { Context } from "koa";
import { isTokenRevoked } from "../services/token-revocation";

export const normalizePhone = (input?: string): string =>
  String(input ?? "").replace(/\D/g, "");

export const normalizeOwnReferralCode = (input?: string): string => {
  const compact = String(input ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (compact.length <= 4) return compact;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
};

const generateReferralCode = (): string => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rand = (n: number) =>
    Array.from({ length: n }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `${rand(4)}-${rand(4)}`;
};

export const generateUniqueOwnReferralCode = async (): Promise<string> => {
  let code = "";
  let exists = false;
  do {
    code = generateReferralCode();
    const found = await strapi.documents("api::account.account").findMany({
      filters: { ownReferralCode: code },
      status: "published",
      limit: 1,
    } as any);
    exists = found.length > 0;
  } while (exists);
  return code;
};

export const issueJwt = (userId: number): string =>
  strapi.plugin("users-permissions").service("jwt").issue({ id: userId });

export const getBearerToken = (ctx: Context): string | null => {
  const authHeader = (ctx.request.headers as any).authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice(7).trim();
};

export const verifyBearer = async (ctx: Context): Promise<any | null> => {
  const token = getBearerToken(ctx);
  if (!token) return null;
  if (isTokenRevoked(token)) return null;
  try {
    return await strapi
      .plugin("users-permissions")
      .service("jwt")
      .verify(token);
  } catch {
    return null;
  }
};

export const getAuthenticatedRoleId = async (): Promise<number> => {
  const role = await strapi
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: "authenticated" } } as any);
  if (!role?.id) {
    throw new Error("Authenticated role introuvable");
  }
  return role.id as number;
};

export const getGlobalReferralReward = async (): Promise<number> => {
  try {
    const list = await strapi
      .documents("api::app-setting.app-setting")
      .findMany({ status: "published", limit: 1 } as any);
    return (list[0] as any)?.referralReward ?? 0;
  } catch {
    return 0;
  }
};

const toAbsoluteUrl = (url?: string | null): string | null => {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const serverUrl =
    process.env.PUBLIC_URL ||
    process.env.STRAPI_URL ||
    `http://localhost:${process.env.PORT || "1337"}`;
  return `${serverUrl.replace(/\/$/, "")}${url}`;
};

export const normalizeAccount = (account: any) => {
  const image = account?.profileImage;
  const rawUrl =
    (Array.isArray(image) ? image[0]?.url : image?.url) ??
    (Array.isArray(image?.data) ? image.data[0]?.url : image?.data?.url);
  return {
    ...account,
    profileImageUrl: toAbsoluteUrl(rawUrl),
  };
};

export const computeHasCompletedProfile = (source: any): boolean => {
  const garageName = String(source?.garageName ?? "").trim();
  const address = String(source?.address ?? "").trim();
  const birthDate = String(source?.birthDate ?? "").trim();
  const postalCode = String(source?.postalCode ?? "").trim();
  return (
    garageName.length > 0 &&
    address.length > 0 &&
    birthDate.length > 0 &&
    postalCode.length > 0
  );
};
