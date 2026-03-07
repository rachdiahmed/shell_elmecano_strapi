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

export default {
  beforeCreate(event: any) {
    assertDeliveredAtWhenDelivered(event?.params?.data);
  },

  beforeUpdate(event: any) {
    assertDeliveredAtWhenDelivered(event?.params?.data);
  },
};
