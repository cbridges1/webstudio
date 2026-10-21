CREATE TABLE "AuthAccount" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp (3) with time zone,
	"refreshTokenExpiresAt" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuthRateLimit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"lastRequest" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuthSession" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"impersonatedBy" text
);
--> statement-breakpoint
CREATE TABLE "AuthVerification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "loginName" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "displayUsername" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "emailVerified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "updatedAt" timestamp(3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "banReason" text;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "banExpires" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "AuthAccount" ADD CONSTRAINT "AuthAccount_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "AuthAccount_userId_idx" ON "AuthAccount" USING btree ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "AuthRateLimit_key_key" ON "AuthRateLimit" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "AuthSession_token_key" ON "AuthSession" USING btree ("token");--> statement-breakpoint
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "AuthVerification_identifier_idx" ON "AuthVerification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "User_loginName_key" ON "User" USING btree ("loginName");