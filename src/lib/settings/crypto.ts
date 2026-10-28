import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const SECRET_FILE = path.resolve(process.cwd(), ".appsecret");

function appSecret(): string {
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (!existsSync(SECRET_FILE)) {
    writeFileSync(SECRET_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return readFileSync(SECRET_FILE, "utf8").trim();
}

function key(): Buffer {
  return scryptSync(appSecret(), "profileforge-key-encryption", 32);
}

/** AES-256-GCM; output format: v1.<iv>.<tag>.<ciphertext> (all hex). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), ct.toString("hex")].join(".");
}

export function decryptSecret(payload: string): string {
  const [version, ivHex, tagHex, ctHex] = payload.split(".");
  if (version !== "v1" || !ivHex || !tagHex || !ctHex) throw new Error("Malformed encrypted payload.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}
