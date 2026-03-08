import type { Context } from "koa";
import { verifyBearer } from "../utils/auth-utils";

const LEADERBOARD_LIMIT = 10;
const CACHE_TTL_MS = Number(process.env.RANKING_CACHE_TTL_MS ?? 1500);

type RankingEntry = {
  id: string;
  rank: number;
  garageName: string;
  address: string;
  vidangesCount: number;
};

type RankingCache = {
  expiresAt: number;
  payload: {
    leaderboard: RankingEntry[];
    total: number;
    generatedAt: string;
  };
};

let top10Cache: RankingCache | null = null;
const streamClients = new Map<
  number,
  {
    res: any;
    userId: number;
    accountId: string;
    me: { rank: number | null; vidangesCount: number };
  }
>();
let streamClientSeq = 0;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;
const STREAM_BROADCAST_MS = Number(
  process.env.RANKING_STREAM_INTERVAL_MS ?? 1000
);

const toInt = (value: unknown): number => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n);
};

const toText = (value: unknown): string => String(value ?? "").trim();

const mapEntry = (account: any, fallbackRank: number): RankingEntry => ({
  id: String(account?.documentId ?? account?.id ?? ""),
  rank: fallbackRank,
  garageName: toText(account?.garageName) || "Garage",
  address: toText(account?.address) || "-",
  vidangesCount: toInt(account?.vidangesCount),
});

const findAccountForUser = async (userId: number) => {
  const list = await strapi.documents("api::account.account").findMany({
    filters: { userId: { $eq: userId } },
    fields: ["garageName", "address", "vidangesCount"] as any,
    status: "published",
    limit: 1,
  } as any);
  return list.length > 0 ? (list[0] as any) : null;
};

const findAccountsForUsers = async (userIds: number[]) => {
  if (userIds.length === 0) return new Map<number, any>();
  const accounts = (await strapi.documents("api::account.account").findMany({
    filters: { userId: { $in: userIds } } as any,
    fields: ["documentId", "id", "userId", "vidangesCount"] as any,
    status: "published",
    limit: userIds.length,
  } as any)) as any[];

  const byUserId = new Map<number, any>();
  for (const account of accounts) {
    const uid = Number(account?.userId ?? 0);
    if (uid > 0 && !byUserId.has(uid)) byUserId.set(uid, account);
  }
  return byUserId;
};

const computeSelfRank = async (selfVidangesCount: number): Promise<number> => {
  const higherCount = await (strapi.db as any)
    .query("api::account.account")
    .count({
      where: {
        vidangesCount: { $gt: selfVidangesCount },
        publishedAt: { $notNull: true },
      },
    });
  return Number(higherCount ?? 0) + 1;
};

const fetchLeaderboard = async (): Promise<{
  leaderboard: RankingEntry[];
  total: number;
  generatedAt: string;
}> => {
  const now = Date.now();
  if (top10Cache && now < top10Cache.expiresAt) return top10Cache.payload;

  const accounts = (await strapi.documents("api::account.account").findMany({
    fields: ["garageName", "address", "vidangesCount"] as any,
    sort: ["vidangesCount:desc", "updatedAt:asc"] as any,
    filters: { vidangesCount: { $gt: 0 } } as any,
    status: "published",
    limit: LEADERBOARD_LIMIT,
  } as any)) as any[];

  const mapped = accounts
    .map((account, index) => mapEntry(account, index + 1))
    .filter((entry) => entry.id.length > 0);

  const payload = {
    leaderboard: mapped,
    total: mapped.length,
    generatedAt: new Date().toISOString(),
  };

  top10Cache = {
    expiresAt: now + CACHE_TTL_MS,
    payload,
  };

  return payload;
};

const startBroadcastLoop = () => {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(async () => {
    if (streamClients.size === 0) {
      if (broadcastTimer) clearInterval(broadcastTimer);
      broadcastTimer = null;
      return;
    }

    const board = await fetchLeaderboard();
    const clientEntries = Array.from(streamClients.entries());
    const userIds = clientEntries.map(([, c]) => c.userId);
    const accountsByUser = await findAccountsForUsers(userIds);
    const uniqueVidanges = new Set<number>();
    for (const account of accountsByUser.values()) {
      const vidanges = toInt(account?.vidangesCount);
      if (vidanges > 0) uniqueVidanges.add(vidanges);
    }
    const rankByVidanges = new Map<number, number>();
    await Promise.all(
      Array.from(uniqueVidanges).map(async (vidanges) => {
        const higherCount = await (strapi.db as any)
          .query("api::account.account")
          .count({
            where: {
              vidangesCount: { $gt: vidanges },
              publishedAt: { $notNull: true },
            },
          });
        rankByVidanges.set(vidanges, Number(higherCount ?? 0) + 1);
      })
    );

    for (const [clientId, client] of clientEntries) {
      try {
        const latestAccount = accountsByUser.get(client.userId);
        if (latestAccount) {
          client.accountId = String(
            latestAccount?.documentId ?? latestAccount?.id ?? ""
          );
        }
        const meInTop = board.leaderboard.find(
          (entry) => entry.id === client.accountId
        );
        let mePayload = client.me;
        if (meInTop && meInTop.id.length > 0) {
          mePayload = {
            rank: meInTop.rank,
            vidangesCount: meInTop.vidangesCount,
          };
        } else if (latestAccount) {
          const vidanges = toInt(latestAccount?.vidangesCount);
          mePayload = {
            rank: vidanges > 0 ? (rankByVidanges.get(vidanges) ?? null) : null,
            vidangesCount: vidanges,
          };
        }
        client.me = mePayload;

        client.res.write(
          `event: ranking\ndata: ${JSON.stringify({
            me: mePayload,
            leaderboard: board.leaderboard,
            total: board.total,
            generatedAt: board.generatedAt,
            nextRefreshInSeconds: Math.max(
              3,
              Math.floor(CACHE_TTL_MS / 1000)
            ),
          })}\n\n`
        );
      } catch {
        try {
          client.res.end();
        } catch {}
        streamClients.delete(clientId);
      }
    }
  }, STREAM_BROADCAST_MS);
};

export default {
  async weekly(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const [self, board] = await Promise.all([
      findAccountForUser(payload.id as number),
      fetchLeaderboard(),
    ]);

    if (!self) return ctx.notFound("Compte introuvable");

    const selfVidangesCount = toInt(self.vidangesCount);
    const selfRank = await computeSelfRank(selfVidangesCount);

    ctx.body = {
      me: {
        rank: selfVidangesCount > 0 ? selfRank : null,
        vidangesCount: selfVidangesCount,
      },
      leaderboard: board.leaderboard,
      total: board.total,
      generatedAt: board.generatedAt,
      nextRefreshInSeconds: Math.max(3, Math.floor(CACHE_TTL_MS / 1000)),
    };
  },

  async stream(ctx: Context) {
    const payload = await verifyBearer(ctx);
    if (!payload?.id) return ctx.unauthorized("Token invalide ou manquant");

    const self = await findAccountForUser(payload.id as number);
    if (!self) return ctx.notFound("Compte introuvable");

    const selfVidangesCount = toInt(self.vidangesCount);
    const selfRank =
      selfVidangesCount > 0 ? await computeSelfRank(selfVidangesCount) : null;
    const me = {
      rank: selfRank,
      vidangesCount: selfVidangesCount,
    };
    const accountId = String(self.documentId ?? self.id ?? "");

    ctx.req.setTimeout(0);
    ctx.respond = false;
    ctx.status = 200;
    ctx.set("Content-Type", "text/event-stream");
    ctx.set("Cache-Control", "no-cache, no-transform");
    ctx.set("Connection", "keep-alive");
    ctx.set("X-Accel-Buffering", "no");

    const res = ctx.res;
    res.write(": connected\n\n");

    const board = await fetchLeaderboard();
    res.write(
      `event: ranking\ndata: ${JSON.stringify({
        me,
        leaderboard: board.leaderboard,
        total: board.total,
        generatedAt: board.generatedAt,
        nextRefreshInSeconds: Math.max(3, Math.floor(CACHE_TTL_MS / 1000)),
      })}\n\n`
    );

    const clientId = ++streamClientSeq;
    streamClients.set(clientId, {
      res,
      userId: Number(payload.id),
      accountId,
      me,
    });
    startBroadcastLoop();

    const onClose = () => {
      streamClients.delete(clientId);
      if (streamClients.size === 0 && broadcastTimer) {
        clearInterval(broadcastTimer);
        broadcastTimer = null;
      }
    };

    ctx.req.on("close", onClose);
    ctx.req.on("end", onClose);
  },
};
