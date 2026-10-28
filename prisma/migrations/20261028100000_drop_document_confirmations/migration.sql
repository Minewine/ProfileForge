-- Fact Guard removal: claim-confirmation fingerprints are no longer written or
-- read (no claim review, no cross-version auto-confirmation).
ALTER TABLE "GeneratedDocument" DROP COLUMN "confirmations";
