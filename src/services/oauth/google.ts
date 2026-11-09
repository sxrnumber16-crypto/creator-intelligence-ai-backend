import { env } from '../../config/env.js';
import { errors } from '../../lib/errors.js';
import { fetchWithRetry } from '../../lib/http.js';

/**
 * Google OAuth 2.0 - Authorization Code flow with offline access.
 * Minimum scopes: identity + YouTube read-only. No write scopes are requested
 * unless a feature explicitly requires them (none do today - the product reads).
 */

export const OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_BASE_URL}/api/auth/google/callback`,
    response_type: 'code',
    scope: OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_BASE_URL}/api/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw errors.upstream('Google OAuth', `token exchange failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const response = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw errors.upstream('Google OAuth', `refresh failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return (await response.json()) as GoogleTokenResponse;
}

export async function revokeToken(token: string): Promise<void> {
  await fetchWithRetry('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

/** Returns a valid access token for a connection, refreshing+persisting when needed. */
export async function refreshConnectionToken(connection: {
  id: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date;
}): Promise<string> {
  const { prisma } = await import('../../lib/prisma.js');
  const { decryptSecret, encryptSecret } = await import('../../lib/crypto.js');

  // 5-minute safety margin
  if (connection.tokenExpiresAt.getTime() > Date.now() + 5 * 60_000) {
    return decryptSecret(connection.accessTokenEnc);
  }

  if (!connection.refreshTokenEnc) {
    throw errors.unauthorized('Google session expired and no refresh token is stored. Reconnect the account.');
  }
  try {
    const refreshed = await refreshAccessToken(decryptSecret(connection.refreshTokenEnc));
    const accessTokenEnc = encryptSecret(refreshed.access_token);
    await prisma.googleConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc,
        tokenExpiresAt: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
        ...(refreshed.refresh_token ? { refreshTokenEnc: encryptSecret(refreshed.refresh_token) } : {}),
      },
    });
    return refreshed.access_token;
  } catch (err) {
    throw errors.unauthorized(
      `Google token refresh failed (${err instanceof Error ? err.message : 'unknown'}). Reconnect the account in Settings > Connections.`,
    );
  }
}

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetchWithRetry('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw errors.upstream('Google OAuth', 'userinfo request failed');
  return (await response.json()) as GoogleUserInfo;
}
