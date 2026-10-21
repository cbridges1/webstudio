import { defineConfig } from "drizzle-kit";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: url ?? "" },
});
