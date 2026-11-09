import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { errors } from '../lib/errors.js';
import { encryptSecret, randomToken, sha256 } from '../lib/crypto.js';
import { issueSessionToken, requireAuth } from '../lib/auth.js';
import { buildAuthorizeUrl, exchangeCodeForTokens, fetchUserInfo, OAUTH_SCOPES, revokeToken } from '../services/oauth/google.js';
import { registerChannelsForConnection } from '../services/sync/syncChannel.js';
import { env } from '../config/env.js';

/**
 * Auth flow (extension-friendly, no cookies):
 * 1. GET  /api/auth/google/authorize?extensionId=<id>  -> { url } (HMAC-signed state)
 * 2. User consents on Google. Google hits /api/auth/google/callback.
 * 3. Backend exchanges code, upserts user + connection + channels, creates a
 *    one-time login code and redirects to https://<extId>.chromiumapp.org/?code=<oneTimeCode>
 * 4. Extension catches the redirect (chrome.identity.launchWebAuthFlow) and
 *    POSTs /api/auth/exchange {code} -> session JWT. The one-time code dies on use.
 */

interface StatePayload { e: string; ts: number }

function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyState(state: string): StatePayload {
  const [body, mac] = state.split('.');
  if (!body || !mac) throw errors.badRequest('Malformed state');
  const expected = crypto.createHmac('sha256', env.JWT_SECRET).update(body).digest('base64url');
  if (mac !== expected) throw errors.badRequest('Invalid state signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
  if (Date.now() - payload.ts > 10 * 60_000) throw errors.badRequest('State expired, restart the sign-in');
  return payload;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/google/authorize', async (request) => {
    const { extensionId } = z.object({ extensionId: z.string().min(20).max(50) }).parse(request.query ?? {});
    const url = buildAuthorizeUrl(signState({ e: extensionId, ts: Date.now() }));
    return { url, scopes: OAUTH_SCOPES };
  });

  app.get('/api/auth/google/callback', async (request, reply) => {
    const query = z.object({ code: z.string().optional(), error: z.string().optional(), state: z.string() }).parse(request.query);
    const state = verifyState(query.state);
    const redirectBase = `https://${state.e}.chromiumapp.org/`;

    if (query.error || !query.code) {
      return reply.redirect(`${redirectBase}?auth_error=${encodeURIComponent(query.error ?? 'cancelled')}`);
    }

    const tokens = await exchangeCodeForTokens(query.code);
    const userInfo = await fetchUserInfo(tokens.access_token);

    const user = await prisma.user.upsert({
      where: { email: userInfo.email },
      create: { email: userInfo.email, displayName: userInfo.name ?? userInfo.email, avatarUrl: userInfo.picture },
      update: { displayName: userInfo.name ?? userInfo.email, avatarUrl: userInfo.picture },
    });

    const connection = await prisma.googleConnection.upsert({
      where: { googleSub: userInfo.sub },
      create: {
        userId: user.id,
        googleSub: userInfo.sub,
        email: userInfo.email,
        accessTokenEnc: encryptSecret(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null,
        tokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
        scopes: tokens.scope.split(' '),
      },
      update: {
        accessTokenEnc: encryptSecret(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : undefined,
        tokenExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000),
        scopes: tokens.scope.split(' '),
      },
    });

    await registerChannelsForConnection(user.id, connection.id, tokens.access_token).catch(() => []);

    // One-time login code stored as a short-lived session row
    const code = randomToken(32);
    await prisma.userSession.create({
      data: {
        userId: user.id,
        tokenHash: sha256(code),
        expiresAt: new Date(Date.now() + 5 * 60_000),
        userAgent: request.headers['user-agent']?.slice(0, 200),
      },
    });

    return reply.redirect(`${redirectBase}?code=${code}`);
  });

  app.post('/api/auth/exchange', async (request) => {
    const { code } = z.object({ code: z.string().min(20) }).parse(request.body);
    const session = await prisma.userSession.findUnique({ where: { tokenHash: sha256(code) }, include: { user: true } });
    if (!session || session.revokedAt) throw errors.unauthorized('Invalid or already-used login code');
    if (session.expiresAt.getTime() < Date.now()) throw errors.unauthorized('Login code expired, sign in again');

    // Promote the one-time session into a 7-day session
    await prisma.userSession.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 7 * 86400_000) },
    });
    const accessToken = await issueSessionToken({ sub: session.userId, sid: session.id, email: session.user.email });
    return {
      accessToken,
      expiresIn: 7 * 86400,
      user: { id: session.user.id, email: session.user.email, displayName: session.user.displayName, avatarUrl: session.user.avatarUrl ?? undefined },
    };
  });

  app.post('/api/auth/refresh', { preHandler: requireAuth }, async (request) => {
    if (!request.userId) throw errors.unauthorized();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId } });
    const accessToken = await issueSessionToken({ sub: user.id, sid: request.sessionId!, email: user.email });
    return { accessToken, expiresIn: 7 * 86400 };
  });

  app.post('/api/auth/logout', { preHandler: requireAuth }, async (request) => {
    await prisma.userSession.update({ where: { id: request.sessionId! }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.userId! } });
    const channels = await prisma.channel.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    const connections = await prisma.googleConnection.findMany({ where: { userId: user.id } });
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl ?? undefined },
      channels: channels.map((c) => ({
        id: c.id,
        connectionId: c.connectionId,
        channelId: c.ytChannelId,
        channelTitle: c.title,
        thumbnailUrl: c.thumbnailUrl ?? undefined,
        isActive: c.isActive,
        connectedAt: c.createdAt.toISOString(),
        scopes: connections.find((conn) => conn.id === c.connectionId)?.scopes ?? [],
      })),
    };
  });

  app.delete('/api/auth/connections/:connectionId', { preHandler: requireAuth }, async (request) => {
    const { connectionId } = z.object({ connectionId: z.string() }).parse(request.params);
    const connection = await prisma.googleConnection.findFirst({ where: { id: connectionId, userId: request.userId! } });
    if (!connection) throw errors.notFound('Connection not found');
    // Revoke at Google, then cascade-delete channels + sessions data owned by this connection
    const { decryptSecret } = await import('../lib/crypto.js');
    if (connection.refreshTokenEnc) {
      await revokeToken(decryptSecret(connection.refreshTokenEnc)).catch(() => undefined);
    }
    await prisma.googleConnection.delete({ where: { id: connectionId } });
    return { ok: true };
  });
}
