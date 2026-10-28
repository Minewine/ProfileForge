-- One profile per user. getOrCreateProfile used a findFirst→create race with
-- no unique constraint on Profile.userId: two concurrent calls could create
-- duplicate rows, after which basics updates and CV imports resolved to
-- different duplicates — imported experience/education/skills landed on a
-- profile the editor never reads, looking "silently dropped". Collapse any
-- existing duplicates before enforcing uniqueness: keep the profile with the
-- most section entries (oldest wins ties), rescue basics onto it from the
-- duplicates, then delete the duplicates (section rows and snapshots cascade
-- via FK).

CREATE TEMP TABLE profile_keeper AS
SELECT DISTINCT ON (p."userId") p."userId", p."id"
FROM "Profile" p
WHERE p."userId" IS NOT NULL
ORDER BY
  p."userId",
  (
    (SELECT COUNT(*) FROM "Experience" e WHERE e."profileId" = p."id")
    + (SELECT COUNT(*) FROM "Education" ed WHERE ed."profileId" = p."id")
    + (SELECT COUNT(*) FROM "Skill" s WHERE s."profileId" = p."id")
    + (SELECT COUNT(*) FROM "LanguageSkill" l WHERE l."profileId" = p."id")
    + (SELECT COUNT(*) FROM "Project" pr WHERE pr."profileId" = p."id")
    + (SELECT COUNT(*) FROM "Certification" c WHERE c."profileId" = p."id")
  ) DESC,
  p."createdAt" ASC;

UPDATE "Profile" keeper
SET "basics" = dup."basics"
FROM "Profile" dup, profile_keeper pk
WHERE pk."id" = keeper."id"
  AND dup."userId" = pk."userId"
  AND dup."id" <> pk."id"
  AND keeper."basics" IS NULL
  AND dup."basics" IS NOT NULL;

DELETE FROM "Profile" p
USING profile_keeper pk
WHERE pk."userId" = p."userId"
  AND p."id" <> pk."id";

DROP TABLE profile_keeper;

-- Enforce one profile per user from here on (replaces the plain userId index).
DROP INDEX IF EXISTS "Profile_userId_idx";
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
