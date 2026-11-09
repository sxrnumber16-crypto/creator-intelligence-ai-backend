import { jwtVerify, SignJWT } from 'jose';
import { env } from '../config/env.js';
import { errors } from './errors.js';
import { prisma } from './prisma.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export interface SessionClaims {
  sub: string; // user id
  sid: string; // session id
  email: string;
}

export async function issueSessionToken(claims: SessionClaims, ttlSeconds = 60 * 60 * 24 * 7): Promise<string> {
  return new SignJWT({ email: claims.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setJti(claims.sid)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, secret);
  if (!payload.sub || !payload.jti) throw errors.unauthorized('Malformed token');
  return { sub: payload.sub, sid: payload.jti, email: String(payload.email ?? '') };
}

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
  }
}

/**
 * Auth preHandler: verifies the JWT and checks the session is still alive
 * (revocation support). Attaches userId / sessionId to the request.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw errors.unauthorized();
  const token = header.slice(7);
  let claims: SessionClaims;
  try {
    claims = await verifySessionToken(token);
  } catch {
    throw errors.unauthorized('Invalid or expired token');
  }
  const session = await prisma.userSession.findUnique({ where: { id: claims.sid } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    throw errors.unauthorized('Session revoked or expired');
  }
  request.userId = claims.sub;
  request.sessionId = claims.sid;
}

/** Resolve the active owned channel for a user, or null. */
export async function getActiveChannel(userId: string) {
  return prisma.channel.findFirst({
    where: { userId, isActive: true },
    include: { connection: true },
  });
}

/**
 * Fastify preHandler: requires auth + an active channel with a connected Google
 * account. Attaches the channel row to request.activeChannel.
 */
export async function requireActiveChannel(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.userId) throw errors.unauthorized();
  const channel = await prisma.channel.findFirst({
    where: { userId: request.userId, isActive: true },
    include: { connection: true },
  });
  if (!channel) {
    throw errors.notConfigured(
      'No active YouTube channel',
      'Connect a Google account with a YouTube channel in Settings > Connections.',
    );
  }
  request.activeChannel = channel;
}

declare module 'fastify' {
  interface FastifyRequest {
    activeChannel?: {
      id: string;
      ytChannelId: string;
      title: string;
      connectionId: string;
      userId: string;
      uploadsPlaylistId: string | null;
    };
  }
}
