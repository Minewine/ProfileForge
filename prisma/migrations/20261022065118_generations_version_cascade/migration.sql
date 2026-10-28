-- DropForeignKey
ALTER TABLE "GeneratedDocumentVersion" DROP CONSTRAINT "GeneratedDocumentVersion_producingJobId_fkey";

-- AddForeignKey
ALTER TABLE "GeneratedDocumentVersion" ADD CONSTRAINT "GeneratedDocumentVersion_producingJobId_fkey" FOREIGN KEY ("producingJobId") REFERENCES "GenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
