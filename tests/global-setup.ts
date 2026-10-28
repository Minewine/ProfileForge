import "dotenv/config";
import { execSync } from "node:child_process";

export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL missing — copy .env.example to .env first.");
  return base.replace(/\/[^/?]+(\?|$)/, "/profileforge_test$1");
}

export default function globalSetup() {
  const url = testDatabaseUrl();
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
