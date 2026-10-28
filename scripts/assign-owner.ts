/**
 * One-time migration helper (specs/008-multi-user-isolation, T037 / FR-009):
 * attaches ALL quarantined pre-multi-user rows (userId NULL — invisible to
 * every account) to one designated owner account.
 *
 * Usage:
 *   npm run db:assign-owner -- --email you@example.com [--password <pw>]
 *
 * - Creates the owner account if absent (--password, or an interactive prompt).
 * - Idempotent: a second run claims nothing and changes nothing.
 * - The legacy "singleton" settings row is attached to the owner, unless the
 *   owner already has their own settings row — then it is dropped (superseded).
 */
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, env, exit } from "node:process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import { normalizeEmail } from "../src/lib/auth/schemas";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
});

export type AssignOwnerResult = {
  user: { id: string; email: string };
  counts: {
    profiles: number;
    sourceDocuments: number;
    jobAnalyses: number;
    llmUsageLogs: number;
    appSettings: number;
  };
};

/**
 * Claims all quarantined rows for the given email (normalized). Creates the
 * account when absent — `password` is required for that in non-interactive
 * use; the CLI prompts for it. Safe to re-run.
 */
export async function assignOwner(rawEmail: string, password?: string): Promise<AssignOwnerResult> {
  const email = normalizeEmail(rawEmail);
  let user = await db.user.findUnique({ where: { email } });
  if (!user) {
    if (!password) throw new Error("Account does not exist yet — a password is required to create it.");
    user = await db.user.create({ data: { email, passwordHash: await hashPassword(password) } });
  }

  const existingSettings = await db.appSettings.findUnique({ where: { userId: user.id } });

  const [profiles, sourceDocuments, jobAnalyses, llmUsageLogs] = await db.$transaction([
    db.profile.updateMany({ where: { userId: null }, data: { userId: user.id } }),
    db.sourceDocument.updateMany({ where: { userId: null }, data: { userId: user.id } }),
    db.jobAnalysis.updateMany({ where: { userId: null }, data: { userId: user.id } }),
    db.llmUsageLog.updateMany({ where: { userId: null }, data: { userId: user.id } }),
  ]);

  // The legacy singleton settings row: attach it, or drop it if the owner
  // already configured their own (the unique constraint would reject both).
  let appSettings = 0;
  if (existingSettings) {
    appSettings = (await db.appSettings.deleteMany({ where: { userId: null } })).count;
  } else {
    appSettings = (await db.appSettings.updateMany({ where: { userId: null }, data: { userId: user.id } })).count;
  }

  return {
    user: { id: user.id, email: user.email },
    counts: { profiles: profiles.count, sourceDocuments: sourceDocuments.count, jobAnalyses: jobAnalyses.count, llmUsageLogs: llmUsageLogs.count, appSettings },
  };
}

async function promptPassword(email: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const pw = await rl.question(`Password for ${email} (min 8 chars): `);
    if (pw.length < 8) throw new Error("Password must be at least 8 characters.");
    return pw;
  } finally {
    rl.close();
  }
}

async function main() {
  const args = argv.slice(2);
  const emailArg = args.indexOf("--email");
  const passwordArg = args.indexOf("--password");
  const email = emailArg >= 0 ? args[emailArg + 1] : undefined;
  let password = passwordArg >= 0 ? args[passwordArg + 1] : undefined;
  if (!email) {
    console.error("Usage: npm run db:assign-owner -- --email <owner@example.com> [--password <pw>]");
    exit(1);
  }

  try {
    const exists = await db.user.findUnique({ where: { email: normalizeEmail(email) } });
    if (!exists && !password) password = await promptPassword(normalizeEmail(email));

    const result = await assignOwner(email, password);
    console.log(`✓ claimed legacy data for ${result.user.email}:`);
    console.log(`  profiles: ${result.counts.profiles}, source documents: ${result.counts.sourceDocuments},`);
    console.log(`  job analyses: ${result.counts.jobAnalyses}, usage logs: ${result.counts.llmUsageLogs}, settings rows: ${result.counts.appSettings}`);
  } catch (err) {
    console.error(`✋ assign-owner failed: ${err instanceof Error ? err.message : err}`);
    exit(1);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1]?.endsWith("assign-owner.ts")) {
  main().catch((err) => {
    console.error(err);
    exit(1);
  });
}
