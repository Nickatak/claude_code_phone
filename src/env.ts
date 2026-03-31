import dotenv from "dotenv";
import path from "path";
import fs from "fs";

const nodeEnv = process.env.NODE_ENV || "development";
const envFile = path.join(__dirname, "..", `.env.${nodeEnv}`);

if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
}
// Always load .env as fallback for values not set by the environment-specific file
dotenv.config();
