import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";

export const TOTP_SECRET_KEY = "admin_totp_secret";
export const TOTP_PENDING_KEY = "admin_totp_secret_pending";

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export async function getActiveTotpSecret(): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: TOTP_SECRET_KEY },
    select: { value: true },
  });
  return row?.value ?? null;
}

export async function getPendingTotpSecret(): Promise<string | null> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: TOTP_PENDING_KEY },
    select: { value: true },
  });
  return row?.value ?? null;
}

function buildTotp(secretBase32: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "WorkerAI",
    label: "Admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function verifyTotpCode(secretBase32: string, code: string): boolean {
  const totp = buildTotp(secretBase32);
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export function getTotpUri(secretBase32: string): string {
  return buildTotp(secretBase32).toString();
}

export async function generateQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { width: 200, margin: 2 });
}
