import type { Context } from "koa";

const FR_TITLE = "Politique de confidentialité";
const FR_CONTENT = `Nous respectons votre vie privée. Vos données sont utilisées uniquement pour faire fonctionner l'application et améliorer votre expérience.

Nous traitons les informations de compte, de profil et les données opérationnelles (gains, classement, commandes) uniquement pour les fonctionnalités essentielles.

Nous ne partageons pas vos données avec des tiers, sauf nécessité technique ou obligation légale.

Vous pouvez demander la modification de vos données ou la suppression de votre compte depuis votre profil.`;

const AR_TITLE = "سياسة الخصوصية";
const AR_CONTENT = `نحن نحترم خصوصيتك. يتم استخدام بياناتك فقط لتشغيل التطبيق وتحسين تجربتك.

نقوم بمعالجة معلومات الحساب والملف الشخصي والبيانات التشغيلية (مثل الأرباح والترتيب والطلبات) فقط للوظائف الأساسية.

لا نشارك بياناتك مع أطراف خارجية إلا عند الحاجة التقنية أو القانونية.

يمكنك طلب تعديل بياناتك أو حذف حسابك من شاشة الملف الشخصي.`;

const normalizeLocale = (raw: unknown): "fr-FR" | "ar-TN" => {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "ar" || value === "ar-tn") return "ar-TN";
  return "fr-FR";
};

const pickFallbackLocale = (locale: "fr-FR" | "ar-TN"): "fr-FR" | "ar-TN" =>
  locale === "fr-FR" ? "ar-TN" : "fr-FR";

export default {
  async privacy(ctx: Context) {
    const locale = normalizeLocale((ctx.request.query as any)?.locale);
    const privacyPolicyDocuments = (
      strapi.documents as unknown as (uid: string) => {
        findFirst: (query: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      }
    )("api::privacy-policy.privacy-policy");

    const query = {
      fields: ["title", "content"] as any,
      status: "published" as const,
      locale,
    };

    let entry = (await privacyPolicyDocuments.findFirst(query as any)) as any;
    if (!entry) {
      entry = (await privacyPolicyDocuments.findFirst({
        ...query,
        locale: pickFallbackLocale(locale),
      } as any)) as any;
    }
    if (!entry) {
      entry = (await privacyPolicyDocuments.findFirst({
        ...query,
        locale: undefined,
      } as any)) as any;
    }

    const title = String(entry?.title ?? "").trim();
    const content = String(entry?.content ?? "").trim();

    ctx.body = {
      locale,
      title: title || (locale === "ar-TN" ? AR_TITLE : FR_TITLE),
      content: content || (locale === "ar-TN" ? AR_CONTENT : FR_CONTENT),
    };
  },
};
