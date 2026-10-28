import "dotenv/config";
import { testDatabaseUrl } from "./global-setup";

// Point every worker's modules (including the @/lib/db singleton) at the test
// database BEFORE anything imports them.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.UPLOADS_DIR = "./uploads-test";
