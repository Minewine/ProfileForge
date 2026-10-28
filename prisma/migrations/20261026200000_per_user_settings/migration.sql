-- Per-user settings (specs/008-multi-user-isolation, T032).
-- userId is nullable @unique: the legacy "singleton" row survives quarantined
-- (NULL owner, invisible to every user) until scripts/assign-owner.ts claims it.
ALTER TABLE "AppSettings" ADD COLUMN "userId" TEXT;
ALTER TABLE "AppSettings" ALTER COLUMN "id" DROP DEFAULT;
CREATE UNIQUE INDEX "AppSettings_userId_key" ON "AppSettings"("userId");
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
