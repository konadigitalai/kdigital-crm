// Drop everything in the public schema. ONLY for dev. Run: npm run db:reset
import { pool } from "./client";

async function main() {
  console.log("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  console.log("✓ public schema reset");
  await pool.end();
}

main().catch((err) => {
  console.error("✗", err.message);
  process.exit(1);
});
