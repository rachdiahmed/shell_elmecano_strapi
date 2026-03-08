import type { Core } from '@strapi/strapi';

const FAKE_TAX_PREFIX = 'FAKE-RANK';

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const randomPick = <T>(items: T[]): T => items[randomInt(0, items.length - 1)];

const makeOwnReferralCode = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${rand(4)}-${rand(4)}`;
};

const createFakeRankingAccounts = async (strapi: Core.Strapi, count: number) => {
  const existing = await strapi.documents('api::account.account').findMany({
    filters: { taxId: { $startsWith: FAKE_TAX_PREFIX } },
    fields: ['taxId'] as any,
    status: 'published',
    limit: 5000,
  } as any);

  const existingCount = existing.length;
  if (existingCount >= count) {
    strapi.log.info(`[seed-ranking] skipped: already ${existingCount} fake accounts`);
    return;
  }

  const toCreate = count - existingCount;
  const cities = [
    'Tunis',
    'Sfax',
    'Sousse',
    'Nabeul',
    'Bizerte',
    'Monastir',
    'Gabes',
    'Kairouan',
    'Ariana',
    'Medenine',
  ];

  for (let i = 0; i < toCreate; i++) {
    const seq = existingCount + i + 1;
    const city = randomPick(cities);
    const vidanges = randomInt(8, 900);
    const rank = seq;
    const taxId = `${FAKE_TAX_PREFIX}-${seq.toString().padStart(4, '0')}`;

    let ownReferralCode = makeOwnReferralCode();
    // Guard collisions on unique ownReferralCode.
    for (let t = 0; t < 5; t++) {
      const found = await strapi.documents('api::account.account').findMany({
        filters: { ownReferralCode },
        fields: ['ownReferralCode'] as any,
        status: 'published',
        limit: 1,
      } as any);
      if (found.length === 0) break;
      ownReferralCode = makeOwnReferralCode();
    }

    await strapi.documents('api::account.account').create({
      data: {
        firstName: 'Garage',
        lastName: `#${seq}`,
        cin: `${90000000 + seq}`,
        phone: `${50000000 + seq}`,
        governorate: city,
        taxId,
        ownReferralCode,
        hasCompletedProfile: true,
        garageName: `Garage ${city} ${seq}`,
        address: `${randomInt(1, 250)} Rue ${city}`,
        postalCode: `${1000 + (seq % 9000)}`,
        rank,
        vidangesCount: vidanges,
        gains: Number((vidanges * 0.05).toFixed(3)),
      } as any,
      status: 'published',
    } as any);
  }

  strapi.log.info(`[seed-ranking] created ${toCreate} fake accounts (target=${count})`);
};

const deleteFakeRankingAccounts = async (strapi: Core.Strapi) => {
  const fakeAccounts = await strapi.documents('api::account.account').findMany({
    filters: { taxId: { $startsWith: FAKE_TAX_PREFIX } },
    fields: ['documentId', 'taxId'] as any,
    status: 'published',
    limit: 10000,
  } as any);

  if (fakeAccounts.length === 0) {
    strapi.log.info('[seed-ranking] cleanup skipped: no fake accounts found');
    return;
  }

  for (const account of fakeAccounts as any[]) {
    const documentId = String(account?.documentId ?? '');
    if (!documentId) continue;
    await strapi.documents('api::account.account').delete({
      documentId,
    } as any);
  }

  strapi.log.info(`[seed-ranking] cleanup done: deleted ${fakeAccounts.length} fake accounts`);
};

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    const shouldDelete = String(process.env.SEED_FAKE_RANKING_DELETE ?? '').trim() === '1';
    if (shouldDelete) {
      await deleteFakeRankingAccounts(strapi);
      return;
    }

    const shouldSeed = String(process.env.SEED_FAKE_RANKING_ON_BOOT ?? '').trim() === '1';
    if (!shouldSeed) return;

    const countRaw = Number(process.env.SEED_FAKE_RANKING_COUNT ?? 400);
    const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : 400;

    await createFakeRankingAccounts(strapi, count);
  },
};
