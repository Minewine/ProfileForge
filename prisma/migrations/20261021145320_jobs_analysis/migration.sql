-- CreateTable
CREATE TABLE "JobAnalysis" (
    "id" TEXT NOT NULL,
    "jdText" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "languageManuallyCorrected" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'created',
    "statusError" TEXT,
    "profileVersion" INTEGER,
    "matchReport" JSONB,
    "semanticDropped" INTEGER NOT NULL DEFAULT 0,
    "notice" TEXT,
    "rerunOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRequirement" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "importance" TEXT NOT NULL,
    "isHardConstraint" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'extracted',
    "userConfirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobAnalysis_rerunOfId_idx" ON "JobAnalysis"("rerunOfId");

-- CreateIndex
CREATE INDEX "JobRequirement_analysisId_idx" ON "JobRequirement"("analysisId");

-- AddForeignKey
ALTER TABLE "JobAnalysis" ADD CONSTRAINT "JobAnalysis_rerunOfId_fkey" FOREIGN KEY ("rerunOfId") REFERENCES "JobAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRequirement" ADD CONSTRAINT "JobRequirement_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "JobAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
