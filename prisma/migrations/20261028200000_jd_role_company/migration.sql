-- Prompt tailoring: the extraction task also returns the JD's role title and
-- hiring company so the generation draft prompts can address the actual role.
ALTER TABLE "JobAnalysis" ADD COLUMN     "jdRole" TEXT;
ALTER TABLE "JobAnalysis" ADD COLUMN     "jdCompany" TEXT;
