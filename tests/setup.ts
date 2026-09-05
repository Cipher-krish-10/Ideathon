import fs from "node:fs";
import path from "node:path";

// Tests run against the real development database, seeded from the approved
// dataset. Node's built-in loader keeps this dependency-free.
const envFile = path.join(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Integration tests need a seeded database: " +
      "npm run db:migrate && npm run db:seed",
  );
}
