require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.log("DATABASE_URL not found in .env.");
    console.log("Available database-like keys:");
    Object.keys(process.env)
      .filter(k => k.includes("DATABASE") || k.startsWith("DB_") || k.includes("MYSQL"))
      .forEach(k => console.log("-", k));
    process.exit(1);
  }

  const conn = await mysql.createConnection(url);

  const [cols] = await conn.query(
    "SHOW COLUMNS FROM businesses WHERE Field LIKE '%website%'"
  );

  console.table(cols);

  await conn.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
