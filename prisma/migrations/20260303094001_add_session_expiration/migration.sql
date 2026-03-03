/*
  Warnings:

  - Added the required column `absoluteExpiresAt` to the `CustomerSession` table without a default value. This is not possible if the table is not empty.
  - Added the required column `expiresAt` to the `CustomerSession` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "CustomerSession" ADD COLUMN     "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "expiresAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE INDEX "CustomerSession_customerId_idx" ON "CustomerSession"("customerId");

-- CreateIndex
CREATE INDEX "CustomerSession_expiresAt_idx" ON "CustomerSession"("expiresAt");

-- CreateIndex
CREATE INDEX "CustomerSession_absoluteExpiresAt_idx" ON "CustomerSession"("absoluteExpiresAt");
