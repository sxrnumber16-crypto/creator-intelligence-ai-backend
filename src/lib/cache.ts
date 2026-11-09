import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    redis.on('error', (err: Error) => {
      console.error('[redis]', err.message);
    });
  }
  return redis;
}

/** JSON cache with TTL. Returns null on miss or when Redis is unavailable. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedis().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await getRedis().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Cache is best-effort; never fail a request because of Redis.
  }
}

export async function cached<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await fetcher();
  await cacheSet(key, value, ttlSeconds);
  return value;
}

/** Cache-aside with in-memory fallback when Redis is not reachable (single instance dev). */
const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();

export async function cachedWithFallback<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key).catch(() => null);
  if (hit !== null) return hit;
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.value as T;
  const value = await fetcher();
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  await cacheSet(key, value, ttlSeconds).catch(() => undefined);
  return value;
}
