export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Not allowed') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (msg = 'Not found') => new AppError(404, 'NOT_FOUND', msg),
  badRequest: (msg = 'Invalid request', details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details),
  rateLimited: (msg = 'Rate limited, retry later') => new AppError(429, 'RATE_LIMITED', msg),
  upstream: (service: string, msg: string) => new AppError(502, 'UPSTREAM_ERROR', `${service}: ${msg}`),
  quotaExceeded: (service: string) =>
    new AppError(429, 'QUOTA_EXCEEDED', `${service} daily quota exhausted. Data will refresh when quota resets (midnight Pacific Time).`),
  dataUnavailable: (msg: string) => new AppError(409, 'DATA_UNAVAILABLE', msg),
  notConfigured: (what: string, how: string) =>
    new AppError(503, 'NOT_CONFIGURED', `${what} is not configured. ${how}`),
};
