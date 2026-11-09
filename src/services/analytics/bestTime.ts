import type { BestTimeResponse } from '@cia/shared';
import { prisma } from '../../lib/prisma.js';
import { median } from '../../lib/http.js';

/**
 * Best-time-to-publish engine.
 *
 * Methodology (shown to users verbatim):
 * 1. For each video published in the range, pull DAILY views from Analytics API.
 * 2. first48hViews = sum of daily views for the first 2 days after publish.
 * 3. Group videos by (publish weekday, publish hour) in the channel's timezone.
 * 4. median first48hViews per cell = heatmap value. Confidence from sample size.
 *
 * Limits we state openly:
 * - This correlates PUBLISH TIME with EARLY TRACTION. It is not audience-presence
 *   data and not a guarantee. Early views also depend on topic, thumbnail, format.
 * - Requires the YouTube Analytics API scope and at least a handful of videos.
 * - Shorts and long-form are analyzed separately (different distribution dynamics).
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function computeBestTime(options: {
  channelDbId: string;
  channelId: string;
  accessToken: string;
  timezone: string;
  format: 'all' | 'shorts' | 'long';
  rangeDays: number;
}): Promise<BestTimeResponse> {
  const since = new Date(Date.now() - options.rangeDays * 86400_000);
  const videos = await prisma.video.findMany({
    where: {
      channelId: options.channelDbId,
      publishedAt: { gte: since },
      ...(options.format === 'shorts' ? { isShort: true } : options.format === 'long' ? { isShort: false } : {}),
    },
    select: { id: true, ytVideoId: true, publishedAt: true, isShort: true },
  });

  const notes: string[] = [
    'Methodology: median views in the first 48 hours after publishing, grouped by publish weekday and hour in the selected timezone, from YouTube Analytics API daily data.',
    'This correlates publish time with early traction - it is NOT audience-presence data and NOT a guarantee. Topic, thumbnail and format also drive early views.',
  ];

  if (videos.length < 5) {
    return {
      timezone: options.timezone,
      format: options.format,
      range: (options.rangeDays === 7 ? 7 : options.rangeDays === 28 ? 28 : options.rangeDays === 90 ? 90 : 365) as 7 | 28 | 90 | 365,
      heatmap: [],
      bestWindows: [],
      sampleSize: videos.length,
      confidence: 'low',
      insufficientData: true,
      methodology: notes[0],
      notes: [...notes, `Only ${videos.length} video(s) in this range - at least 5 are needed. Publish consistently and check back.`],
    };
  }

  const analyticsApi = await import('../youtube/analyticsApi.js');
  const cell = new Map<string, { values: number[] }>();

  // Batch query daily views for all videos in range (single query, video dimension filter per video would be N calls;
  // instead query channel-wide daily views once and derive first-48h from per-video day rows via `video` filter is too costly).
  // Efficient approach: one query with dimensions=day grouped per video is not supported; so we query per-video first-48h
  // for up to 40 most recent videos.
  const targets = videos.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()).slice(0, 40);

  for (const video of targets) {
    const start = video.publishedAt.toISOString().slice(0, 10);
    const end = new Date(video.publishedAt.getTime() + 2 * 86400_000).toISOString().slice(0, 10);
    const { report } = await analyticsApi.analyticsQuery(options.accessToken, {
      ids: 'channel==MINE',
      startDate: start,
      endDate: end,
      metrics: ['views'],
      dimensions: ['day'],
      filters: `video==${video.ytVideoId}`,
    });
    const first48 = (report.rows ?? []).reduce((acc, row) => acc + Number(row.values[1] ?? 0), 0);
    const local = toZonedParts(video.publishedAt, options.timezone);
    const key = `${local.weekday}-${local.hour}`;
    const entry = cell.get(key) ?? { values: [] };
    entry.values.push(first48);
    cell.set(key, entry);
  }

  const heatmap = [...cell.entries()].map(([key, { values }]) => {
    const [weekday, hour] = key.split('-').map(Number);
    return {
      weekday,
      hour,
      medianFirst48hViews: median(values),
      sampleSize: values.length,
    };
  });

  const ranked = [...heatmap]
    .filter((h) => h.sampleSize >= 2 && h.medianFirst48hViews != null)
    .sort((a, b) => (b.medianFirst48hViews ?? 0) - (a.medianFirst48hViews ?? 0));

  const bestWindows = ranked.slice(0, 4).map((h) => ({
    label: `${WEEKDAYS[h.weekday]} around ${String(h.hour).padStart(2, '0')}:00`,
    weekday: h.weekday,
    startHour: h.hour,
    medianFirst48hViews: h.medianFirst48hViews ?? 0,
    sampleSize: h.sampleSize,
    confidence: h.sampleSize >= 4 ? ('high' as const) : h.sampleSize >= 3 ? ('medium' as const) : ('low' as const),
  }));

  const totalSample = heatmap.reduce((acc, h) => acc + h.sampleSize, 0);
  const confidence = totalSample >= 25 ? 'high' : totalSample >= 12 ? 'medium' : 'low';
  if (totalSample < 25) {
    notes.push(`Sample size (${totalSample} videos) is limited - treat windows as indicative, not conclusive.`);
  }

  return {
    timezone: options.timezone,
    format: options.format,
    range: (options.rangeDays === 7 ? 7 : options.rangeDays === 28 ? 28 : options.rangeDays === 90 ? 90 : 365) as 7 | 28 | 90 | 365,
    heatmap,
    bestWindows,
    sampleSize: totalSample,
    confidence,
    methodology: notes[0],
    notes,
  };
}

function toZonedParts(date: Date, timeZone: string): { weekday: number; hour: number } {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const weekdayStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayStr);
    return { weekday: weekday < 0 ? 0 : weekday, hour };
  } catch {
    // Invalid timezone string - fall back to UTC
    return { weekday: date.getUTCDay(), hour: date.getUTCHours() };
  }
}

export const bestTimeMeta = { WEEKDAYS };
