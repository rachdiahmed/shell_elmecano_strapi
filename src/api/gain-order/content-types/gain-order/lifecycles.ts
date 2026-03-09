import { errors } from "@strapi/utils";

const { ValidationError } = errors;

const isEmpty = (value: unknown): boolean => {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
};

const assertDeliveredAtWhenDelivered = (data: any) => {
  if (!data) return;
  if (data.orderStatus !== "delivered") return;
  if (isEmpty(data.deliveredAt)) {
    throw new ValidationError(
      "Le champ deliveredAt est obligatoire lorsque le statut est livré."
    );
  }
};

const statusLabel = (value: string): string => {
  switch (value) {
    case "validating":
      return "En cours de validation";
    case "processing":
      return "En cours de traitement";
    case "shipping":
      return "En cours de livraison";
    case "delivered":
      return "Livré";
    case "cancelled":
      return "Annulé";
    default:
      return value;
  }
};

const notifyOrderStatusChange = async (order: any, previousStatus: string) => {
  const debugPush = String(process.env.FCM_DEBUG ?? "").trim() === "1";
  const nextStatus = String(order?.orderStatus ?? "").trim();
  if (debugPush) {
    strapi.log.info(
      `[FCM][gain-order] status change check: prev=${previousStatus || "-"} next=${nextStatus || "-"} code=${String(
        order?.code ?? ""
      )}`
    );
  }
  if (!nextStatus || nextStatus === previousStatus) {
    if (debugPush) strapi.log.info("[FCM][gain-order] no status transition detected, skipping notification");
    return;
  }

  const accountDocId = String(
    order?.account?.documentId ?? order?.account?.id ?? ""
  ).trim();
  if (!accountDocId) {
    if (debugPush) strapi.log.warn("[FCM][gain-order] missing account document id, cannot notify");
    return;
  }

  const code = String(order?.code ?? "").trim();
  if (debugPush) {
    strapi.log.info(`[FCM][gain-order] creating in-app notification for account=${accountDocId}`);
  }
  await strapi.service("api::auth.notification-center").createInAppNotification(
    accountDocId,
    {
      type: "order_status_changed",
      title: "Mise à jour de votre commande",
      body: `Commande ${code || ""} : ${statusLabel(nextStatus)}.`.trim(),
      data: {
        targetScreen: "gains",
        orderId: String(order?.documentId ?? order?.id ?? ""),
        orderCode: code,
        previousStatus,
        currentStatus: nextStatus,
      },
    }
  );
};

export default {
  beforeCreate(event: any) {
    assertDeliveredAtWhenDelivered(event?.params?.data);
  },

  async beforeUpdate(event: any) {
    assertDeliveredAtWhenDelivered(event?.params?.data);
    const where = event?.params?.where ?? {};
    const documentId = String(where.documentId ?? "").trim();
    const id = Number(where.id ?? 0);
    if (!event.state) event.state = {};

    try {
      if (documentId) {
        const existing = await strapi.documents("api::gain-order.gain-order").findOne({
          documentId,
          fields: ["orderStatus"] as any,
        } as any);
        event.state.previousStatus = String(existing?.orderStatus ?? "");
        if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
          strapi.log.info(
            `[FCM][gain-order] beforeUpdate doc=${documentId} previousStatus=${event.state.previousStatus || "-"}`
          );
        }
        return;
      }
      if (id > 0) {
        const existing = await (strapi.db as any)
          .query("api::gain-order.gain-order")
          .findOne({
            where: { id },
            select: ["orderStatus"],
          });
        event.state.previousStatus = String(existing?.orderStatus ?? "");
        if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
          strapi.log.info(
            `[FCM][gain-order] beforeUpdate id=${id} previousStatus=${event.state.previousStatus || "-"}`
          );
        }
      }
    } catch {
      event.state.previousStatus = "";
    }
  },

  async afterUpdate(event: any) {
    const result = event?.result;
    if (!result) return;

    const previousStatus = String(event?.state?.previousStatus ?? "");
    if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
      strapi.log.info(
        `[FCM][gain-order] afterUpdate doc=${String(result.documentId ?? "-")} previousStatus=${previousStatus || "-"}`
      );
    }
    const full = await strapi.documents("api::gain-order.gain-order").findOne({
      documentId: String(result.documentId ?? ""),
      fields: ["documentId", "code", "orderStatus"] as any,
      populate: {
        account: {
          fields: ["documentId"] as any,
        },
      },
    } as any);

    if (!full) return;
    await notifyOrderStatusChange(full, previousStatus);
  },
};
