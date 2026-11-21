import { requireThat } from '../../../packages/records/src/record.mjs';

const plans = [
  { id: 'local-free', name: '本机免费', storageGb: 0, monthly: 0, yearly: 0 },
  { id: 'storage-5g', name: '5 GB 标准空间', storageGb: 5, monthly: 1800, yearly: 17200 },
  { id: 'storage-20g', name: '20 GB 进阶空间', storageGb: 20, monthly: 3800, yearly: 36500 },
  { id: 'storage-100g', name: '100 GB 归档空间', storageGb: 100, monthly: 8800, yearly: 84500 },
];

export function billingCatalog() {
  return { currency: 'CNY', checkout: false, plans };
}

export function billingQuote(planId, period) {
  const plan = plans.find(item => item.id === planId);
  requireThat(plan && (period === 'monthly' || period === 'yearly'), 'billing_quote_unavailable', 400);
  // shortcut: the catalog is a preview until checkout and real storage entitlements are provisioned.
  return { planId: plan.id, period, amount: plan[period], currency: 'CNY', payable: false };
}
