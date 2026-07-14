/**

 * Keep in sync with src/config/subscriptionPlans.js

 */



export const PLAN_IDS = {

  TRIAL: 'trial',

  SOLE: 'sole_proprietor',

  ADMIN: 'admin',

};



export const BASE_AMOUNTS = {

  [PLAN_IDS.SOLE]: 45000,

  [PLAN_IDS.ADMIN]: 150000,

};



const PLAN_BY_AMOUNT_BASE = {

  45000: PLAN_IDS.SOLE,

  150000: PLAN_IDS.ADMIN,

};



const MONTHS_BY_AMOUNT = {

  45000: 1,

  150000: 3,

};



export const DEFAULT_SUBSCRIPTION_MARKUP = {

  sole_proprietorMarkupPercent: 0,

  adminMarkupPercent: 0,

  enterpriseMarkupPercent: 0,

};



export function clampMarkupPercent(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.min(200, Math.max(-50, n));

}



export function applyMarkup(basePrice, markupPercent) {

  const base = Number(basePrice) || 0;

  const pct = clampMarkupPercent(markupPercent);

  if (base <= 0) return 0;

  return Math.max(0, Math.round(base * (1 + pct / 100)));

}



export function normalizeSubscriptionMarkup(data = {}) {

  return {

    sole_proprietorMarkupPercent: clampMarkupPercent(data.sole_proprietorMarkupPercent ?? 0),

    adminMarkupPercent: clampMarkupPercent(data.adminMarkupPercent ?? 0),

    enterpriseMarkupPercent: clampMarkupPercent(data.enterpriseMarkupPercent ?? 0),

  };

}



export async function fetchSubscriptionMarkup(firestore) {

  if (!firestore) return { ...DEFAULT_SUBSCRIPTION_MARKUP };

  try {

    const snap = await firestore.doc('platform_settings/subscription_pricing').get();

    if (!snap.exists) return { ...DEFAULT_SUBSCRIPTION_MARKUP };

    return normalizeSubscriptionMarkup(snap.data());

  } catch {

    return { ...DEFAULT_SUBSCRIPTION_MARKUP };

  }

}



export function getEffectiveAmounts(markup = DEFAULT_SUBSCRIPTION_MARKUP) {

  const normalized = normalizeSubscriptionMarkup(markup);

  return {

    [PLAN_IDS.SOLE]: applyMarkup(BASE_AMOUNTS[PLAN_IDS.SOLE], normalized.sole_proprietorMarkupPercent),

    [PLAN_IDS.ADMIN]: applyMarkup(BASE_AMOUNTS[PLAN_IDS.ADMIN], normalized.adminMarkupPercent),

  };

}



export function monthsForAmount(amount) {

  const base = BASE_AMOUNTS[PLAN_IDS.SOLE];

  const adminBase = BASE_AMOUNTS[PLAN_IDS.ADMIN];

  if (Number(amount) === adminBase) return 3;

  if (Number(amount) === base) return 1;

  const effective = getEffectiveAmounts();

  if (Number(amount) === effective[PLAN_IDS.ADMIN]) return 3;

  if (Number(amount) === effective[PLAN_IDS.SOLE]) return 1;

  return MONTHS_BY_AMOUNT[Number(amount)] ?? 1;

}



export function planIdForAmount(amount, markup = DEFAULT_SUBSCRIPTION_MARKUP) {

  const num = Number(amount);

  const effective = getEffectiveAmounts(markup);

  if (num === effective[PLAN_IDS.ADMIN] || num === BASE_AMOUNTS[PLAN_IDS.ADMIN]) return PLAN_IDS.ADMIN;

  if (num === effective[PLAN_IDS.SOLE] || num === BASE_AMOUNTS[PLAN_IDS.SOLE]) return PLAN_IDS.SOLE;

  return PLAN_BY_AMOUNT_BASE[num] ?? null;

}



export function validateChargePayload({ amount, plan, phone, provider }, markup = DEFAULT_SUBSCRIPTION_MARKUP) {

  if (!amount || !phone || !provider || !plan) {

    return { ok: false, message: 'Missing required fields: amount, phone, provider, plan' };

  }

  const numAmount = Number(amount);

  const effective = getEffectiveAmounts(markup);

  const allowedAmounts = [effective[PLAN_IDS.SOLE], effective[PLAN_IDS.ADMIN]];

  if (!allowedAmounts.includes(numAmount)) {

    return {

      ok: false,

      message: `Invalid amount. Valid: ${allowedAmounts.join(' or ')} MWK for current pricing.`,

    };

  }

  const expectedPlan = planIdForAmount(numAmount, markup);

  if (plan !== expectedPlan) {

    return {

      ok: false,

      message: `Plan "${plan}" does not match amount ${numAmount}. Expected "${expectedPlan}".`,

    };

  }

  if (!/^\+265(99|88)\d{7}$/.test(phone)) {

    return { ok: false, message: 'Invalid phone. Use +26599XXXXXX or +26588XXXXXX' };

  }

  const providers = ['airtel', 'tnm'];

  if (!providers.includes(provider)) {

    return { ok: false, message: "Invalid provider. Use 'airtel' or 'tnm'" };

  }

  return { ok: true, amount: numAmount, plan };

}



export function planDisplayName(plan) {

  if (plan === PLAN_IDS.ADMIN) return 'Admin Plan (150,000 MWK / 3 months)';

  if (plan === PLAN_IDS.SOLE) return 'Sole Proprietor Plan (45,000 MWK / month)';

  return String(plan || 'Subscription');

}


