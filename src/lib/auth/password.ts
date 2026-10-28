import { hash, verify } from "@node-rs/argon2";

/** Argon2id with library-default cost parameters. */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/** Constant-time verification; a malformed hash is a failed verification, not a crash. */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
