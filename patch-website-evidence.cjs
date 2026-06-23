require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error("DATABASE_URL not found in .env");
  }

  const conn = await mysql.createConnection(url);

  const [existing] = await conn.query(
    "SHOW COLUMNS FROM businesses LIKE 'websiteEvidence'"
  );

  if (existing.length > 0) {
    console.log("websiteEvidence column already exists. No change needed.");
  } else {
    await conn.query(
      "ALTER TABLE businesses ADD COLUMN websiteEvidence JSON NULL"
    );
    console.log("websiteEvidence column added successfully.");
  }

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
