import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { prisma } from './lib/prisma.js';
import { authRoutes } from './routes/auth.js';
import { channelRoutes } from './routes/channels.js';
import { videoRoutes } from './routes/videos.js';
import { keywordRoutes } from './routes/keywords.js';
import { seoRoutes } from './routes/seo.js';
import { competitorRoutes } from './routes/competitors.js';
import { aiRoutes } from './routes/ai.js';
import { miscRoutes } from './routes/misc.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } } : {}),
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  // CORS: extension origins + configured web origins. No wildcard in production
  // unless explicitly set via CORS_ORIGINS.
  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      const allowed = origins.some((pattern) =>
        pattern === '*' || origin === pattern || (pattern.endsWith('*') && origin.startsWith(pattern.slice(0, -1))),
      );
      cb(null, allowed);
    },
    credentials: false,
    maxAge: 86400,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === 'production' ? 300 : 1000,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } }),
  });

  // Security headers (CSP for the callback redirect page, clickjacking protection)
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  // Central error handling: AppError -> structured JSON; zod -> 400; else 500
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    if (error.validation) {
      reply.status(400).send({ error: { code: 'BAD_REQUEST', message: error.message } });
      return;
    }
    if ((error as { statusCode?: number }).statusCode === 429) {
      reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down.' } });
      return;
    }
    request.log.error(error, 'Unhandled error');
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'Unexpected server error. Check backend logs.' } });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
  });

  await app.register(authRoutes);
  await app.register(channelRoutes);
  await app.register(videoRoutes);
  await app.register(keywordRoutes);
  await app.register(seoRoutes);
  await app.register(competitorRoutes);
  await app.register(aiRoutes);
  await app.register(miscRoutes);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  return app;
}
