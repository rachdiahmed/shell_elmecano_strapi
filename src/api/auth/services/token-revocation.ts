import crypto from "crypto";

type RevokedTokenEntry = {
  expiresAt: number;
};

const revokedTokens = new Map<string, RevokedTokenEntry>();

const hashToken = (token: string): string =>
  crypto.createHash("sha256").update(token).digest("hex");

const defaultExpiryMs = 7 * 24 * 60 * 60 * 1000;

const cleanupExpired = () => {
  const now = Date.now();
  for (const [hash, entry] of revokedTokens.entries()) {
    if (entry.expiresAt <= now) revokedTokens.delete(hash);
  }
};

export const revokeToken = (token: string, expiresAtUnixSeconds?: number): void => {
  if (!token || !token.trim()) return;
  cleanupExpired();
  const now = Date.now();
  const expiresAt =
    typeof expiresAtUnixSeconds === "number" && Number.isFinite(expiresAtUnixSeconds)
      ? Math.max(now, expiresAtUnixSeconds * 1000)
      : now + defaultExpiryMs;

  revokedTokens.set(hashToken(token.trim()), { expiresAt });
};

export const isTokenRevoked = (token: string): boolean => {
  if (!token || !token.trim()) return false;
  cleanupExpired();
  const entry = revokedTokens.get(hashToken(token.trim()));
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) {
    revokedTokens.delete(hashToken(token.trim()));
    return false;
  }
  return true;
};

