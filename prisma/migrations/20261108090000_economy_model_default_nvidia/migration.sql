-- AlterTable
-- minimax/minimax-m3.1-flash:free was retired upstream on 2026-10-22; new users must
-- default to a live free model. Existing rows keep their stored value (already nvidia
-- since 2026-10-28) — column default only, no data migration. See STATUS.md §4 item 2.
ALTER TABLE "AppSettings" ALTER COLUMN "modelEconomy" SET DEFAULT 'nvidia/nemotron-3.5-super-vl:free';
