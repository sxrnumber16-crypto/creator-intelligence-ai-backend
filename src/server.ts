import { buildApp } from './app.js';
import { env } from './config/env.js';
import { startWorkers } from './jobs/queues.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Background workers (BullMQ). In production these could run as a separate
  // process; the modular monolith starts them in-process for simplicity.
  const workers = startWorkers();
  workers.forEach((w) => w.on('failed', (job, err) => app.log.error({ job: job?.name, err: err.message }, 'Background job failed')));

  const shutdown = async (): Promise<void> => {
    app.log.info('Shutting down...');
    for (const w of workers) await w.close().catch(() => undefined);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`Creator Intelligence AI backend listening on :${env.PORT}`);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
