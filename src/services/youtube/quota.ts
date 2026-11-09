import { prisma } from '../../lib/prisma.js';
import { errors } from '../../lib/errors.js';
import { dateOnly } from '../../lib/http.js';

/**
 * Quota accounting for YouTube APIs. Google enforces per-project daily quotas
 * (Data API default 10,000 units; Analytics API 50,000 units). We track usage
 * per active channel and refuse calls early with a clear message instead of
 * burning quota or failing mid-request.
 */

export const DAILY_LIMITS = {
  data_api: 10_000,
  analytics_api: 50_000,
} as const;

export type QuotaService = keyof typeof DAILY_LIMITS;

export async function recordQuota(channelId: string, service: QuotaService, units: number): Promise<void> {
  if (units <= 0) return;
  const today = new Date(dateOnly(new Date()));
  await prisma.quotaUsage.upsert({
    where: { channelId_date_service: { channelId, date: today, service } },
    create: { channelId, date: today, service, unitsUsed: units },
    update: { unitsUsed: { increment: units } },
  });
}

export async function getQuota(channelId: string, service: QuotaService): Promise<number> {
  const today = new Date(dateOnly(new Date()));
  const row = await prisma.quotaUsage.findUnique({
    where: { channelId_date_service: { channelId, date: today, service } },
  });
  return row?.unitsUsed ?? 0;
}

export async function assertQuota(channelId: string, service: QuotaService, estimatedUnits: number): Promise<void> {
  const used = await getQuota(channelId, service);
  if (used + estimatedUnits > DAILY_LIMITS[service]) {
    throw errors.quotaExceeded(service === 'data_api' ? 'YouTube Data API' : 'YouTube Analytics API');
  }
}

export async function quotaStatusFor(channelId: string) {
  const today = new Date(dateOnly(new Date()));
  const rows = await prisma.quotaUsage.findMany({
    where: { channelId, date: today },
  });
  const dataApi = rows.find((r) => r.service === 'data_api')?.unitsUsed ?? 0;
  const analytics = rows.find((r) => r.service === 'analytics_api')?.unitsUsed ?? 0;
  return {
    date: dateOnly(new Date()),
    dataApiUnitsUsed: dataApi,
    dataApiDailyLimit: DAILY_LIMITS.data_api,
    analyticsApiUnitsUsed: analytics,
    analyticsDailyLimit: DAILY_LIMITS.analytics_api,
  };
}
