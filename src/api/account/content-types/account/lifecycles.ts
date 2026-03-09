type Top3Entry = { id: string; vidangesCount: number };

const fetchTop3 = async (): Promise<Top3Entry[]> => {
  const accounts = (await strapi.documents("api::account.account").findMany({
    fields: ["documentId", "id", "vidangesCount"] as any,
    sort: ["vidangesCount:desc", "updatedAt:asc"] as any,
    filters: { vidangesCount: { $gt: 0 } } as any,
    limit: 3,
  } as any)) as any[];

  return accounts
    .map((a) => ({
      id: String(a?.documentId ?? a?.id ?? "").trim(),
      vidangesCount: Number(a?.vidangesCount ?? 0),
    }))
    .filter((x) => x.id.length > 0);
};

const notifyDroppedFromTop3 = async (droppedAccountIds: string[]) => {
  if (!droppedAccountIds.length) return;
  const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
  if (debugPush) {
    strapi.log.info(
      `[FCM][top3] dropped accounts=${droppedAccountIds.join(",")}`
    );
  }
  for (const accountId of droppedAccountIds) {
    await strapi.service("api::auth.notification-center").createInAppNotification(
      accountId,
      {
        type: "ranking_dropped_top3",
        title: "Classement",
        body: "Vous n'êtes plus dans le top 3. Continuez, vous pouvez remonter !",
        data: { targetScreen: "ranking" },
      }
    );
  }
};

export default {
  async beforeUpdate(event: any) {
    if (!event.state) event.state = {};
    event.state.top3Before = await fetchTop3();
    if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
      strapi.log.info(
        `[FCM][top3] beforeUpdate top3=${(event.state.top3Before as Top3Entry[])
          .map((x) => `${x.id}:${x.vidangesCount}`)
          .join(",")}`
      );
    }
  },

  async afterUpdate(event: any) {
    const beforeEntries = (event?.state?.top3Before ?? []) as Top3Entry[];
    const before = beforeEntries.map((x) => x.id);
    if (!before.length) return;
    const afterEntries = await fetchTop3();
    const after = afterEntries.map((x) => x.id);
    const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
    if (debugPush) {
      strapi.log.info(
        `[FCM][top3] afterUpdate top3=${afterEntries
          .map((x) => `${x.id}:${x.vidangesCount}`)
          .join(",")}`
      );
    }
    const dropped = before.filter((id) => !after.includes(id));
    if (debugPush && dropped.length === 0) {
      strapi.log.info("[FCM][top3] no account dropped from top3");
    }
    await notifyDroppedFromTop3(dropped);
  },
};
