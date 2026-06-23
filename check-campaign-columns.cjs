require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [cols] = await conn.query(
    "SHOW COLUMNS FROM campaigns WHERE Field IN ('contentStyle', 'referenceStyle', 'preferredCta', 'excludedOffers')"
  );

  console.table(cols);

  await conn.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
