ALTER TABLE "Deployer" DROP CONSTRAINT "Deployer_workspaceId_fkey";
--> statement-breakpoint
ALTER TABLE "ProjectDeployTarget" DROP CONSTRAINT "ProjectDeployTarget_deployerId_fkey";
--> statement-breakpoint
DROP INDEX "Deployer_workspaceId_idx";--> statement-breakpoint
DROP INDEX "ProjectDeployTarget_deployerId_idx";--> statement-breakpoint
-- One deployer for the whole builder: keep the one most projects use (the oldest on a tie).
DELETE FROM "Deployer" WHERE "id" <> (
	SELECT d."id" FROM "Deployer" d
	LEFT JOIN "ProjectDeployTarget" t ON t."deployerId" = d."id"
	GROUP BY d."id", d."createdAt"
	ORDER BY count(t."projectId") DESC, d."createdAt"
	LIMIT 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "Deployer_single_key" ON "Deployer" USING btree ((true));--> statement-breakpoint
ALTER TABLE "Deployer" DROP COLUMN "workspaceId";--> statement-breakpoint
ALTER TABLE "Deployer" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "ProjectDeployTarget" DROP COLUMN "deployerId";