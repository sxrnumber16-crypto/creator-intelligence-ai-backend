import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)'),
  JWT_SECRET: z.string().min(16),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  YOUTUBE_API_KEY: z.string().default(''),
  CORS_ORIGINS: z.string().default('chrome-extension://*'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  OPENAI_API_KEY: z.string().optional().default(''),
  GEMINI_API_KEY: z.string().optional().default(''),
  SENTRY_DSN: z.string().optional().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail loudly and early: misconfiguration must never be silently ignored.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

export const requiredCredentialsConfigured = () => ({
  googleOAuth: !env.GOOGLE_CLIENT_ID.startsWith('REPLACE') && !env.GOOGLE_CLIENT_SECRET.startsWith('REPLACE'),
  youtubeApiKey: env.YOUTUBE_API_KEY.length > 0 && !env.YOUTUBE_API_KEY.startsWith('REPLACE'),
  encryption: !env.ENCRYPTION_KEY.startsWith('REPLACE'),
  anthropic: env.ANTHROPIC_API_KEY.length > 0,
  openai: env.OPENAI_API_KEY.length > 0,
  gemini: env.GEMINI_API_KEY.length > 0,
});
