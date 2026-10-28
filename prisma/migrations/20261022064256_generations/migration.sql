-- CreateTable
CREATE TABLE "GenerationJob" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "statusError" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "runId" TEXT,
    "profileVersion" INTEGER NOT NULL,
    "notice" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "confirmations" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneratedDocumentVersion" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "producingJobId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "validationReport" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "artifacts" JSONB NOT NULL DEFAULT '[]',
    "extractionCheck" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GeneratedDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationJob_analysisId_idx" ON "GenerationJob"("analysisId");

-- CreateIndex
CREATE INDEX "GenerationJob_status_idx" ON "GenerationJob"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_analysisId_kind_key" ON "GeneratedDocument"("analysisId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocumentVersion_producingJobId_key" ON "GeneratedDocumentVersion"("producingJobId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocumentVersion_documentId_version_key" ON "GeneratedDocumentVersion"("documentId", "version");

-- AddForeignKey
ALTER TABLE "GenerationJob" ADD CONSTRAINT "GenerationJob_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "JobAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "JobAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocumentVersion" ADD CONSTRAINT "GeneratedDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "GeneratedDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneratedDocumentVersion" ADD CONSTRAINT "GeneratedDocumentVersion_producingJobId_fkey" FOREIGN KEY ("producingJobId") REFERENCES "GenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
