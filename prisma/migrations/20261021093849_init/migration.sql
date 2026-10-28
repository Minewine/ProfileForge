-- CreateTable
CREATE TABLE "SourceDocument" (
    "id" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "detectedLanguage" TEXT NOT NULL,
    "languageManuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "pageCount" INTEGER,
    "paragraphCount" INTEGER,
    "extractedPages" JSONB NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "requiresPartialParseConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "parseStatus" TEXT NOT NULL DEFAULT 'unparsed',
    "parseError" TEXT,
    "parseResult" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Profile" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "language" TEXT NOT NULL,
    "basics" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experience" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "skillsUsed" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "Experience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bullet" (
    "id" TEXT NOT NULL,
    "experienceId" TEXT,
    "projectId" TEXT,
    "educationId" TEXT,
    "text" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "containmentOk" BOOLEAN,
    "reviewFlag" TEXT,

    CONSTRAINT "Bullet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Education" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "degree" TEXT,
    "field" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "grade" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "Education_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "level" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LanguageSkill" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "proficiency" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "LanguageSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "link" TEXT,
    "startDate" TEXT,
    "endDate" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certification" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT,
    "issueDate" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "provenance" TEXT NOT NULL DEFAULT 'user_entered',
    "sourceDocumentId" TEXT,
    "sourceLocator" JSONB,
    "language" TEXT,
    "confidence" DOUBLE PRECISION,
    "reviewFlag" TEXT,

    CONSTRAINT "Certification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileSnapshot" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "cause" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "openRouterKeyEncrypted" TEXT,
    "keyHint" TEXT,
    "modelEconomy" TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash',
    "modelPremium" TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-4.5',
    "costCapUsd" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmUsageLog" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Experience_profileId_idx" ON "Experience"("profileId");

-- CreateIndex
CREATE INDEX "Bullet_experienceId_idx" ON "Bullet"("experienceId");

-- CreateIndex
CREATE INDEX "Bullet_projectId_idx" ON "Bullet"("projectId");

-- CreateIndex
CREATE INDEX "Bullet_educationId_idx" ON "Bullet"("educationId");

-- CreateIndex
CREATE INDEX "Education_profileId_idx" ON "Education"("profileId");

-- CreateIndex
CREATE INDEX "Skill_profileId_name_idx" ON "Skill"("profileId", "name");

-- CreateIndex
CREATE INDEX "LanguageSkill_profileId_idx" ON "LanguageSkill"("profileId");

-- CreateIndex
CREATE INDEX "Project_profileId_idx" ON "Project"("profileId");

-- CreateIndex
CREATE INDEX "Certification_profileId_idx" ON "Certification"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileSnapshot_profileId_version_key" ON "ProfileSnapshot"("profileId", "version");

-- CreateIndex
CREATE INDEX "LlmUsageLog_runId_idx" ON "LlmUsageLog"("runId");

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experience" ADD CONSTRAINT "Experience_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bullet" ADD CONSTRAINT "Bullet_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bullet" ADD CONSTRAINT "Bullet_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bullet" ADD CONSTRAINT "Bullet_educationId_fkey" FOREIGN KEY ("educationId") REFERENCES "Education"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bullet" ADD CONSTRAINT "Bullet_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Education" ADD CONSTRAINT "Education_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguageSkill" ADD CONSTRAINT "LanguageSkill_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LanguageSkill" ADD CONSTRAINT "LanguageSkill_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certification" ADD CONSTRAINT "Certification_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "SourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileSnapshot" ADD CONSTRAINT "ProfileSnapshot_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
