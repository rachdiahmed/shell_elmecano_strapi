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

const toNumber = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const shouldRefundOnCancel = (
  previousStatus: string,
  nextStatus: string,
): boolean => {
  if (nextStatus !== "cancelled") return false;
  return ["validating", "processing", "shipping"].includes(previousStatus);
};

const refundCancelledOrderAmount = async (order: any) => {
  const accountDocumentId = String(
    order?.account?.documentId ?? order?.account?.id ?? "",
  ).trim();
  if (!accountDocumentId) return;

  const account = await strapi.documents("api::account.account").findOne({
    documentId: accountDocumentId,
    fields: ["gains"] as any,
    status: "published",
  } as any);

  if (!account) return;

  const refundedAmount = round3(toNumber(order?.amount));
  if (refundedAmount <= 0) return;

  const currentGains = round3(toNumber(account.gains));
  await strapi.documents("api::account.account").update({
    documentId: accountDocumentId,
    data: {
      gains: round3(currentGains + refundedAmount),
    } as any,
    status: "published",
  } as any);
};

const markCancelRefundApplied = async (orderDocumentId: string) => {
  if (!orderDocumentId) return;
  await strapi.documents("api::gain-order.gain-order").update({
    documentId: orderDocumentId,
    data: {
      cancelRefundApplied: true,
    } as any,
    status: "published",
  } as any);
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
          fields: ["orderStatus", "cancelRefundApplied"] as any,
        } as any);
        event.state.previousStatus = String(existing?.orderStatus ?? "");
        event.state.previousCancelRefundApplied =
          (existing as any)?.cancelRefundApplied === true;
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
            select: ["orderStatus", "cancelRefundApplied"],
          });
        event.state.previousStatus = String(existing?.orderStatus ?? "");
        event.state.previousCancelRefundApplied =
          (existing as any)?.cancelRefundApplied === true;
        if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
          strapi.log.info(
            `[FCM][gain-order] beforeUpdate id=${id} previousStatus=${event.state.previousStatus || "-"}`
          );
        }
      }
    } catch {
      event.state.previousStatus = "";
      event.state.previousCancelRefundApplied = false;
    }
  },

  async afterUpdate(event: any) {
    const result = event?.result;
    if (!result) return;

    const previousStatus = String(event?.state?.previousStatus ?? "");
    const previousCancelRefundApplied =
      event?.state?.previousCancelRefundApplied === true;
    if (String(process.env.FCM_DEBUG ?? "").trim() === "1") {
      strapi.log.info(
        `[FCM][gain-order] afterUpdate doc=${String(result.documentId ?? "-")} previousStatus=${previousStatus || "-"}`
      );
    }
    const full = await strapi.documents("api::gain-order.gain-order").findOne({
      documentId: String(result.documentId ?? ""),
      fields: [
        "documentId",
        "code",
        "orderStatus",
        "amount",
        "cancelRefundApplied",
      ] as any,
      populate: {
        account: {
          fields: ["documentId"] as any,
        },
      },
    } as any);

    if (!full) return;
    if (
      shouldRefundOnCancel(previousStatus, String(full.orderStatus ?? "")) &&
      !previousCancelRefundApplied &&
      (full as any).cancelRefundApplied !== true
    ) {
      await refundCancelledOrderAmount(full);
      await markCancelRefundApplied(String(full.documentId ?? ""));
    }
    await notifyOrderStatusChange(full, previousStatus);
  },
};
