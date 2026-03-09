import crypto from "crypto";
import fs from "fs";

type InAppNotificationType =
  | "referral_used"
  | "order_status_changed"
  | "ranking_dropped_top3"
  | "system";

type InAppNotification = {
  id: string;
  type: InAppNotificationType;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  data?: Record<string, unknown>;
};

const MAX_NOTIFICATIONS = 100;
const FCM_SEND_URL = "https://fcm.googleapis.com/fcm/send";
const FCM_V1_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedV1Token: { token: string; expiresAtMs: number } | null = null;

type FirebaseServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

const normalizeType = (raw: unknown): InAppNotificationType => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (
    value === "referral_used" ||
    value === "order_status_changed" ||
    value === "ranking_dropped_top3"
  ) {
    return value;
  }
  return "system";
};

const sanitizeNotifications = (raw: unknown): InAppNotification[] => {
  if (!Array.isArray(raw)) return [];
  const list: InAppNotification[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = String(obj.id ?? "").trim();
    if (!id) continue;
    list.push({
      id,
      type: normalizeType(obj.type),
      title: String(obj.title ?? "").trim(),
      body: String(obj.body ?? "").trim(),
      createdAt: String(obj.createdAt ?? new Date().toISOString()),
      readAt: obj.readAt == null ? null : String(obj.readAt),
      data:
        obj.data && typeof obj.data === "object"
          ? (obj.data as Record<string, unknown>)
          : undefined,
    });
  }
  return list;
};

const findAccountForUser = async (userId: number) => {
  const accounts = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    fields: ["documentId", "id", "inAppNotifications"] as any,
    status: "published",
    limit: 1,
  } as any);
  return accounts.length ? (accounts[0] as any) : null;
};

const findAccountByDocumentIdOrId = async (accountRef: string) => {
  const value = String(accountRef ?? "").trim();
  if (!value) return null;

  const byDocumentId = (await strapi.documents("api::account.account").findOne({
    documentId: value,
    fields: ["documentId", "id", "inAppNotifications"] as any,
    status: "published",
  } as any)) as any;
  if (byDocumentId) return byDocumentId;

  const numericId = Number(value);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;
  const byId = (await strapi.db.query("api::account.account").findOne({
    where: { id: numericId },
    select: ["id", "documentId", "inAppNotifications"],
  } as any)) as any;
  return byId ?? null;
};

const saveNotifications = async (accountDocumentId: string, items: InAppNotification[]) => {
  try {
    await strapi.documents("api::account.account").update({
      documentId: accountDocumentId,
      data: { inAppNotifications: items } as any,
      status: "published",
    } as any);
    return;
  } catch (e: any) {
    const message = String(e?.message ?? e);
    // Fallback for accounts that may contain broken relations in other fields.
    const account = await findAccountByDocumentIdOrId(accountDocumentId);
    const id = Number(account?.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) throw e;
    await (strapi.db as any).query("api::account.account").update({
      where: { id },
      data: { inAppNotifications: items },
    });
    if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
      strapi.log.warn(
        `[FCM] saveNotifications fallback via db.query for account=${accountDocumentId}, reason=${message}`
      );
    }
  }
};

const sendPushIfConfigured = async (
  accountDocumentId: string,
  payload: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }
) => {
  const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
  const tokens = (await strapi
    .service("api::auth.push-device")
    .getActiveDeviceTokensForAccount(accountDocumentId)) as string[];
  if (!tokens.length) {
    if (debugPush) strapi.log.warn(`[FCM] no active device tokens for account=${accountDocumentId}`);
    return;
  }

  const serviceAccount = getFirebaseServiceAccount();
  const v1ProjectId = serviceAccount?.projectId ?? "";
  const v1ClientEmail = serviceAccount?.clientEmail ?? "";
  const v1PrivateKey = serviceAccount?.privateKey ?? "";
  if (debugPush) {
    strapi.log.info(
      `[FCM] send attempt account=${accountDocumentId} tokens=${tokens.length} v1Project=${v1ProjectId || "-"} v1Email=${v1ClientEmail ? "set" : "missing"} v1Key=${v1PrivateKey ? "set" : "missing"}`
    );
  }

  if (v1ProjectId && v1ClientEmail && v1PrivateKey) {
    try {
      const accessToken = await getV1AccessToken({
        clientEmail: v1ClientEmail,
        privateKey: v1PrivateKey,
      });
      await Promise.all(
        tokens.map((token) =>
          sendV1(token, payload, {
            projectId: v1ProjectId,
            accessToken,
            debugPush,
          })
        )
      );
      return;
    } catch (e: any) {
      if (debugPush) strapi.log.error(`[FCM v1] send failed: ${String(e?.message ?? e)}`);
    }
  }

  const serverKey = String(process.env.FCM_SERVER_KEY ?? "").trim();
  if (!serverKey) {
    if (debugPush) {
      strapi.log.warn(
        "[FCM] missing FCM v1 credentials (set FCM_SERVICE_ACCOUNT_JSON or FCM_PROJECT_ID/FCM_CLIENT_EMAIL/FCM_PRIVATE_KEY) and no FCM_SERVER_KEY fallback"
      );
    }
    return;
  }
  await Promise.all(tokens.map((token) => sendLegacy(token, payload, serverKey)));
};

const getFirebaseServiceAccount = (): FirebaseServiceAccount | null => {
  const jsonPath = String(process.env.FCM_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (jsonPath) {
    try {
      const raw = fs.readFileSync(jsonPath, "utf8");
      const json = JSON.parse(raw) as Record<string, unknown>;
      const projectId = String(json.project_id ?? "").trim();
      const clientEmail = String(json.client_email ?? "").trim();
      const privateKey = normalizePrivateKey(String(json.private_key ?? "").trim());
      if (projectId && clientEmail && privateKey) {
        return { projectId, clientEmail, privateKey };
      }
    } catch {}
  }

  const projectId = String(process.env.FCM_PROJECT_ID ?? "").trim();
  const clientEmail = String(process.env.FCM_CLIENT_EMAIL ?? "").trim();
  const privateKey = normalizePrivateKey(String(process.env.FCM_PRIVATE_KEY ?? "").trim());
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
};

const base64Url = (input: string) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const signJwtRs256 = (data: string, privateKey: string): string => {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer
    .sign(privateKey, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

const normalizePrivateKey = (raw: string): string => {
  if (!raw) return "";
  let key = raw.trim();

  // Remove surrounding single/double quotes when present.
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1);
  }

  // Handle common .env encodings.
  key = key
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .trim();

  // If header/footer are inline on one line, expand them.
  key = key
    .replace(
      /-----BEGIN PRIVATE KEY-----\s*/g,
      "-----BEGIN PRIVATE KEY-----\n"
    )
    .replace(
      /\s*-----END PRIVATE KEY-----/g,
      "\n-----END PRIVATE KEY-----"
    )
    .trim();

  if (!key.endsWith("\n")) key += "\n";
  return key;
};

const getV1AccessToken = async (input: {
  clientEmail: string;
  privateKey: string;
}): Promise<string> => {
  const nowSec = Math.floor(Date.now() / 1000);
  if (cachedV1Token && cachedV1Token.expiresAtMs > Date.now() + 30_000) {
    return cachedV1Token.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: input.clientEmail,
    scope: FCM_V1_SCOPE,
    aud: FCM_OAUTH_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = signJwtRs256(unsigned, input.privateKey);
  const assertion = `${unsigned}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(FCM_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error("FCM OAuth token request failed");
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  const token = String(json.access_token ?? "").trim();
  if (!token) throw new Error("FCM OAuth token missing");
  const expiresInSec = Number(json.expires_in ?? 3600);
  cachedV1Token = {
    token,
    expiresAtMs: Date.now() + Math.max(60, expiresInSec - 30) * 1000,
  };
  return token;
};

const sendV1 = async (
  token: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
  auth: { projectId: string; accessToken: string; debugPush?: boolean }
) => {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(
        auth.projectId
      )}/messages:send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: payload.title,
              body: payload.body,
            },
            data: Object.fromEntries(
              Object.entries(payload.data ?? {}).map(([k, v]) => [k, String(v)])
            ),
            android: { priority: "high" },
          },
        }),
      }
    );
    if (auth.debugPush) {
      const masked = `${token.substring(0, 10)}...${token.substring(
        Math.max(0, token.length - 8)
      )}`;
      if (res.ok) {
        strapi.log.info(`[FCM v1] send ok token=${masked}`);
      } else {
        const body = await res.text();
        strapi.log.error(`[FCM v1] send failed status=${res.status} token=${masked} body=${body}`);
      }
    }
  } catch {}
};

const sendLegacy = async (
  token: string,
  payload: { title: string; body: string; data?: Record<string, unknown> },
  serverKey: string
) => {
  try {
    await fetch(FCM_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `key=${serverKey}`,
      },
      body: JSON.stringify({
        to: token,
        priority: "high",
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: payload.data ?? {},
      }),
    });
  } catch {}
};

const paginate = <T>(items: T[], page: number, pageSize: number) => {
  const p = page > 0 ? page : 1;
  const ps = pageSize > 0 ? pageSize : 20;
  const start = (p - 1) * ps;
  const end = start + ps;
  const sliced = items.slice(start, end);
  return {
    items: sliced,
    page: p,
    pageSize: ps,
    total: items.length,
    hasMore: end < items.length,
  };
};

export const createInAppNotification = async (
  accountDocumentId: string,
  payload: {
    type: InAppNotificationType;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }
) => {
  const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
  const account = await findAccountByDocumentIdOrId(accountDocumentId);
  if (!account) {
    if (debugPush) strapi.log.warn(`[FCM] account not found for notification target=${accountDocumentId}`);
    return null;
  }

  const current = sanitizeNotifications(account.inAppNotifications);
  const next: InAppNotification = {
    id: crypto.randomUUID(),
    type: payload.type,
    title: String(payload.title ?? "").trim(),
    body: String(payload.body ?? "").trim(),
    createdAt: new Date().toISOString(),
    readAt: null,
    data: payload.data,
  };

  const merged = [next, ...current].slice(0, MAX_NOTIFICATIONS);
  await saveNotifications(String(account.documentId ?? account.id ?? ""), merged);
  if (debugPush) {
    strapi.log.info(
      `[FCM] in-app notification saved account=${String(
        account.documentId ?? account.id ?? ""
      )} type=${next.type} title=${next.title}`
    );
  }
  await sendPushIfConfigured(String(account.documentId ?? account.id ?? ""), {
    title: next.title,
    body: next.body,
    data: {
      notificationId: next.id,
      type: next.type,
      ...(next.data ?? {}),
    },
  });
  return next;
};

export const listInAppNotificationsForUser = async (
  userId: number,
  page: number,
  pageSize: number
) => {
  const account = await findAccountForUser(userId);
  if (!account) return null;
  const items = sanitizeNotifications(account.inAppNotifications).sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1
  );
  const readCount = items.filter((x) => x.readAt != null).length;
  const paged = paginate(items, page, pageSize);
  return {
    ...paged,
    unreadCount: items.length - readCount,
  };
};

export const markInAppNotificationRead = async (
  userId: number,
  notificationId: string
) => {
  const account = await findAccountForUser(userId);
  if (!account) return null;
  const id = String(notificationId ?? "").trim();
  if (!id) return null;

  const now = new Date().toISOString();
  const items = sanitizeNotifications(account.inAppNotifications);
  let touched = false;
  const next = items.map((item) => {
    if (item.id !== id || item.readAt != null) return item;
    touched = true;
    return { ...item, readAt: now };
  });

  if (touched) {
    await saveNotifications(String(account.documentId ?? account.id ?? ""), next);
  }
  return { success: true, updated: touched };
};

export const markAllInAppNotificationsRead = async (userId: number) => {
  const account = await findAccountForUser(userId);
  if (!account) return null;

  const now = new Date().toISOString();
  const items = sanitizeNotifications(account.inAppNotifications);
  let touched = 0;
  const next = items.map((item) => {
    if (item.readAt != null) return item;
    touched += 1;
    return { ...item, readAt: now };
  });

  if (touched > 0) {
    await saveNotifications(String(account.documentId ?? account.id ?? ""), next);
  }
  return { success: true, updated: touched };
};

export default {
  createInAppNotification,
  listInAppNotificationsForUser,
  markInAppNotificationRead,
  markAllInAppNotificationsRead,
};
