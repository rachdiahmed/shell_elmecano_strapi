const getGlobalReferralReward = async (): Promise<number> => {
  try {
    const list = await strapi
      .documents("api::app-setting.app-setting")
      .findMany({ status: "published", limit: 1 } as any);
    return (list[0] as any)?.referralReward ?? 0;
  } catch {
    return 0;
  }
};

const findSponsorByOwnReferralCode = async (code: string) => {
  const sponsors = await strapi
    .documents("api::account.account")
    .findMany({
      filters: { ownReferralCode: code },
      status: "published",
      limit: 1,
    } as any);
  return sponsors.length ? sponsors[0] : null;
};

const applyReferralForNewAccount = async (sponsorDocumentId: string) => {
  const sponsor = await strapi.documents("api::account.account").findOne({
    documentId: sponsorDocumentId,
    status: "published",
  } as any);
  if (!sponsor) return;

  const reward = await getGlobalReferralReward();
  if (!reward || reward <= 0) return;

  const currentGains = Number((sponsor as any).gains ?? 0);
  await strapi.documents("api::account.account").update({
    documentId: sponsorDocumentId,
    data: {
      gains: currentGains + reward,
    } as any,
    status: "published",
  } as any);
};

const notifySponsorReferralUsed = async (
  sponsorDocumentId: string,
  referredDisplayName?: string
) => {
  const name = String(referredDisplayName ?? "").trim();
  const suffix = name ? ` (${name})` : "";
  await strapi.service("api::auth.notification-center").createInAppNotification(
    sponsorDocumentId,
    {
      type: "referral_used",
      title: "Parrainage utilisé",
      body: `Votre code de parrainage a été utilisé${suffix}.`,
      data: { referredDisplayName: name || null },
    }
  );
};

export default {
  findSponsorByOwnReferralCode,
  applyReferralForNewAccount,
  notifySponsorReferralUsed,
};
