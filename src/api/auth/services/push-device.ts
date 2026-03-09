type NotificationDevice = {
  token: string;
  platform: "android" | "ios" | "web" | "unknown";
  locale?: string;
  appEnv?: "dev" | "staging" | "prod" | "unknown";
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
};

const MAX_DEVICES_PER_ACCOUNT = 20;

const normalizePlatform = (raw: unknown): NotificationDevice["platform"] => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "android" || value === "ios" || value === "web") return value;
  return "unknown";
};

const normalizeAppEnv = (raw: unknown): NotificationDevice["appEnv"] => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "dev" || value === "staging" || value === "prod") return value;
  return "unknown";
};

const sanitizeDevices = (raw: unknown): NotificationDevice[] => {
  if (!Array.isArray(raw)) return [];
  const devices: NotificationDevice[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const obj = x as Record<string, unknown>;
    const token = String(obj.token ?? "").trim();
    if (!token) continue;
    const now = new Date().toISOString();
    devices.push({
      token,
      platform: normalizePlatform(obj.platform),
      locale: String(obj.locale ?? "").trim() || undefined,
      appEnv: normalizeAppEnv(obj.appEnv),
      isActive: obj.isActive !== false,
      createdAt: String(obj.createdAt ?? now),
      updatedAt: String(obj.updatedAt ?? now),
      lastSeenAt: String(obj.lastSeenAt ?? now),
    });
  }
  return devices;
};

const findAccountForUser = async (userId: number) => {
  const accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    fields: ["documentId", "id", "notificationDevices"] as any,
    status: "published",
    limit: 1,
  } as any);
  return accounts.length ? (accounts[0] as any) : null;
};

const findAccountByDocumentId = async (documentId: string) => {
  return (await strapi.documents("api::account.account").findOne({
    documentId,
    fields: ["documentId", "id", "notificationDevices"] as any,
    status: "published",
  } as any)) as any;
};

const saveDevices = async (account: any, devices: NotificationDevice[]) => {
  await strapi.documents("api::account.account").update({
    documentId: account.documentId,
    data: {
      notificationDevices: devices,
    } as any,
    status: "published",
  } as any);
};

export const upsertDeviceToken = async (
  userId: number,
  input: {
    token: string;
    platform?: string;
    locale?: string;
    appEnv?: string;
  }
) => {
  const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
  const account = await findAccountForUser(userId);
  if (!account) {
    if (debugPush) strapi.log.warn(`[FCM] upsert token failed: account not found for userId=${userId}`);
    return null;
  }

  const token = String(input.token ?? "").trim();
  if (!token) return null;
  if (token.length > 4096) return null;

  const now = new Date().toISOString();
  const devices = sanitizeDevices(account.notificationDevices);
  const existingIndex = devices.findIndex((d) => d.token === token);

  const nextDevice: NotificationDevice = {
    token,
    platform: normalizePlatform(input.platform),
    locale: String(input.locale ?? "").trim() || undefined,
    appEnv: normalizeAppEnv(input.appEnv),
    isActive: true,
    createdAt: existingIndex >= 0 ? devices[existingIndex].createdAt : now,
    updatedAt: now,
    lastSeenAt: now,
  };

  if (existingIndex >= 0) {
    devices[existingIndex] = nextDevice;
  } else {
    devices.unshift(nextDevice);
  }

  const trimmed = devices.slice(0, MAX_DEVICES_PER_ACCOUNT);
  await saveDevices(account, trimmed);
  if (debugPush) {
    strapi.log.info(
      `[FCM] token registered account=${String(
        account.documentId ?? account.id ?? ""
      )} activeDevices=${trimmed.filter((d) => d.isActive).length}`
    );
  }

  return {
    accountId: String(account.documentId ?? account.id ?? ""),
    activeDevices: trimmed.filter((d) => d.isActive).length,
  };
};

export const deactivateDeviceToken = async (
  userId: number,
  token?: string | null
) => {
  const account = await findAccountForUser(userId);
  if (!account) return null;

  const targetToken = String(token ?? "").trim();
  const now = new Date().toISOString();
  const devices = sanitizeDevices(account.notificationDevices);
  let touched = 0;

  const next = devices.map((device) => {
    const shouldDeactivate = targetToken
      ? device.token === targetToken && device.isActive
      : device.isActive;
    if (!shouldDeactivate) return device;
    touched += 1;
    return {
      ...device,
      isActive: false,
      updatedAt: now,
      lastSeenAt: now,
    };
  });

  if (touched > 0) {
    await saveDevices(account, next);
  }

  return {
    accountId: String(account.documentId ?? account.id ?? ""),
    updatedDevices: touched,
  };
};

export const getActiveDeviceTokensForAccount = async (
  accountDocumentId: string
): Promise<string[]> => {
  const account = await findAccountByDocumentId(accountDocumentId);
  if (!account) return [];
  return sanitizeDevices(account.notificationDevices)
    .filter((x) => x.isActive)
    .map((x) => x.token)
    .filter((x) => x.length > 0);
};

export default {
  upsertDeviceToken,
  deactivateDeviceToken,
  getActiveDeviceTokensForAccount,
};
