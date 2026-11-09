import { Queue, Worker, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { getRedis } from '../lib/cache.js';
import { prisma } from '../lib/prisma.js';
import { syncChannel } from '../services/sync/syncChannel.js';
import { snapshotCompetitor } from '../services/competitors/tracker.js';

/**
 * Background jobs (BullMQ + Redis):
 *  - channel-sync: refresh owned channel snapshot + videos + analytics
 *  - competitor-sync: snapshot tracked competitors + refresh public videos
 *  - notify: diff snapshots and create notifications
 * Schedules use repeatable jobs; all handlers are idempotent.
 */

export const QUEUE_NAME = 'cia-jobs';

export interface JobPayload {
  kind: 'channel-sync' | 'competitor-sync' | 'notify';
  channelId?: string;
  competitorId?: string;
  userId?: string;
}

let queue: Queue<JobPayload> | null = null;

export function jobQueue(): Queue<JobPayload> {
  if (!queue) {
    queue = new Queue<JobPayload>(QUEUE_NAME, { connection: getRedis() });
  }
  return queue;
}

export async function scheduleRecurringJobs(): Promise<void> {
  const q = jobQueue();
  // Channels: sync every 6 hours (quota-aware; manual sync available anytime)
  await q.add('recurring', { kind: 'notify' }, { repeat: { pattern: '0 */6 * * *' } } satisfies JobsOptions);
}

function createWorkerSafely(
  name: string,
  processor: (job: { data: JobPayload; name: string }) => Promise<void>,
  opts: { connection: ReturnType<typeof getRedis>; concurrency: number },
): Worker<JobPayload> | null {
  try {
    return new Worker<JobPayload>(QUEUE_NAME, processor as never, opts);
  } catch (err) {
    console.error(`[jobs] worker "${name}" could not start (Redis unavailable?) - background jobs disabled:`, err instanceof Error ? err.message : err);
    return null;
  }
}

export function startWorkers(): Worker<JobPayload>[] {
  const shared = { connection: getRedis(), concurrency: 2 };

  const mainWorker = createWorkerSafely(
    'main',
    async (job) => {
      const data = job.data;
      const run = await prisma.jobRun.create({
        data: { userId: data.userId ?? null, job: data.kind, status: 'running', startedAt: new Date() },
      });
      try {
        if (data.kind === 'channel-sync' && data.channelId) {
          await syncChannel(data.channelId);
        } else if (data.kind === 'competitor-sync' && data.competitorId) {
          await snapshotCompetitor(data.competitorId, env.YOUTUBE_API_KEY);
        } else if (data.kind === 'notify') {
          await runNotificationCycle();
        }
        await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'ok', finishedAt: new Date() } });
      } catch (err) {
        await prisma.jobRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), detail: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
        });
        // Surface sync failures to the affected user when identifiable
        if (data.channelId) {
          const channel = await prisma.channel.findUnique({ where: { id: data.channelId } });
          if (channel) {
            await createNotification(
              channel.userId,
              'sync_failure',
              'Channel sync failed',
              `${channel.title}: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
            );
          }
        }
        throw err;
      }
    },
    shared,
  );

  // Dispatcher: expands the recurring scheduler ticks into per-channel /
  // per-competitor jobs. The main worker above processes the expanded jobs.
  const dispatcher = createWorkerSafely(
    'dispatcher',
    async (job) => {
      if (job.name === 'channels') {
        const channels = await prisma.channel.findMany({ where: { isActive: true }, select: { id: true } });
        for (const c of channels) {
          await jobQueue().add('run-channel-sync', { kind: 'channel-sync', channelId: c.id }, { removeOnComplete: 20, removeOnFail: 20 });
        }
      } else if (job.name === 'competitors') {
        const competitors = await prisma.competitor.findMany({ select: { id: true } });
        for (const c of competitors) {
          await jobQueue().add('run-competitor-sync', { kind: 'competitor-sync', competitorId: c.id }, { removeOnComplete: 20, removeOnFail: 20 });
        }
      }
    },
    { ...shared, concurrency: 1 },
  );

  // Register repeatable schedulers on boot (guard against Redis being down at boot)
  (async () => {
    try {
      const q = jobQueue();
      await q.add('channels', { kind: 'notify' }, { repeat: { pattern: '0 */6 * * *' }, removeOnComplete: 10 });
      await q.add('competitors', { kind: 'notify' }, { repeat: { pattern: '30 5 * * *' }, removeOnComplete: 10 });
    } catch (err) {
      console.error('[jobs] scheduler registration failed (Redis down?)', err);
    }
  })();

  return [mainWorker, dispatcher].filter((w): w is Worker<JobPayload> => w !== null);
}

// ---------------------------------------------------------------------------
// Notification generation from snapshot diffs
// ---------------------------------------------------------------------------

async function runNotificationCycle(): Promise<void> {
  const channels = await prisma.channel.findMany({
    where: { isActive: true },
    include: { snapshots: { orderBy: { capturedAt: 'desc' }, take: 2 } },
  });
  for (const channel of channels) {
    if (channel.snapshots.length < 2) continue;
    const [latest, previous] = channel.snapshots;
    const settings = await prisma.notificationSettings.findUnique({ where: { userId: channel.userId } });

    if (settings?.performance !== false && latest.subscribers != null && previous.subscribers != null) {
      const delta = latest.subscribers - previous.subscribers;
      if (Math.abs(delta) >= Math.max(10, previous.subscribers * 0.02)) {
        await createNotification(
          channel.userId,
          'performance',
          delta > 0 ? 'Subscriber growth spike' : 'Subscriber drop detected',
          `${channel.title}: ${delta > 0 ? '+' : ''}${delta.toLocaleString()} subscribers between snapshots (${previous.capturedAt.toISOString().slice(0, 10)} to ${latest.capturedAt.toISOString().slice(0, 10)}).`,
        );
      }
    }
  }

  // Competitor uploads (last 24h, since last notification check)
  const competitors = await prisma.competitor.findMany({
    where: { lastSyncAt: { not: null } },
    include: { videos: { where: { publishedAt: { gte: new Date(Date.now() - 48 * 3600_000) } }, orderBy: { publishedAt: 'desc' }, take: 3 } },
  });
  for (const competitor of competitors) {
    if (competitor.videos.length === 0) continue;
    const settings = await prisma.notificationSettings.findUnique({ where: { userId: competitor.userId } });
    if (settings?.competitorUploads === false) continue;
    const dedupeTitle = `New upload: ${competitor.videos[0].title}`;
    const existing = await prisma.notification.findFirst({ where: { userId: competitor.userId, title: dedupeTitle } });
    if (!existing) {
      await createNotification(
        competitor.userId,
        'competitor_upload',
        dedupeTitle,
        `${competitor.title} published ${competitor.videos.length} new video(s) in the last 48h: ${competitor.videos.map((v) => `"${v.title}"`).join(', ')}`,
      );
    }
  }
}

export async function createNotification(userId: string, type: string, title: string, body: string): Promise<void> {
  await prisma.notification.create({ data: { userId, type, title, body } });
}
