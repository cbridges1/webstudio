-- selfhost: sign-in by email. Every account with a password needs an email first; give one
-- to each account listed in the error (e.g. UPDATE "User" SET email = '...' WHERE "loginName" = '...'),
-- then run the migrations again.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(coalesce(u."loginName", u.id), ', ') INTO missing
  FROM "User" u
  WHERE (u.email IS NULL OR trim(u.email) = '')
    AND EXISTS (SELECT 1 FROM "AuthAccount" a WHERE a."userId" = u.id AND a."providerId" = 'credential');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Accounts without an email can''t sign in by email: %', missing;
  END IF;
END $$;--> statement-breakpoint
-- Emails are the sign-in name, compared lowercased.
UPDATE "User" u SET email = lower(trim(u.email))
WHERE u.email <> lower(trim(u.email))
  AND EXISTS (SELECT 1 FROM "AuthAccount" a WHERE a."userId" = u.id AND a."providerId" = 'credential');--> statement-breakpoint
DROP INDEX "User_loginName_key";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "loginName";--> statement-breakpoint
ALTER TABLE "User" DROP COLUMN "displayUsername";