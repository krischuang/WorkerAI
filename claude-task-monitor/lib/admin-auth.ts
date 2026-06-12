/**
 * Admin-panel bcrypt helpers — Node.js runtime only.
 * Do NOT import this file in middleware.ts (bcryptjs is not edge-compatible).
 *
 * Edge-compatible cookie helpers (adminCookieToken, ADMIN_COOKIE) live in
 * middleware.ts and are re-exported here for convenience.
 */

export { ADMIN_COOKIE, adminCookieToken } from "@/middleware";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

const BCRYPT_ROUNDS = 12;
export const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";

export async function hashAdminPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyAdminPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Verify a submitted admin password against the stored bcrypt hash.
 *
 * If no hash is in the DB yet, falls back to direct comparison with
 * ADMIN_PASSWORD (bootstrap mode) and stores the hash on first success.
 */
export async function checkAdminLogin(submitted: string): Promise<boolean> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: ADMIN_PASSWORD_HASH_KEY },
    select: { value: true },
  });

  if (row) {
    return verifyAdminPassword(submitted, row.value);
  }

  // Bootstrap: no hash stored yet — compare directly against env var.
  const envPassword = process.env.ADMIN_PASSWORD;
  if (!envPassword || submitted !== envPassword) return false;

  // Store the hash so future logins use bcrypt.
  const hash = await hashAdminPassword(envPassword);
  await prisma.systemConfig.upsert({
    where: { key: ADMIN_PASSWORD_HASH_KEY },
    create: { key: ADMIN_PASSWORD_HASH_KEY, value: hash },
    update: { value: hash },
  });
  return true;
}
