import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'vlt_';

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `2027-10-01` expires at 2027-10-01T00:00:00Z; full timestamps are used as they are. */
export function expiryTime(expires: string | null | undefined): number | null {
  if (!expires) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(expires) ? `${expires}T00:00:00Z` : expires);
  return Number.isNaN(t) ? null : t;
}

export function isExpired(expires: string | null | undefined, now = Date.now()): boolean {
  const t = expiryTime(expires);
  return t !== null && now >= t;
}
