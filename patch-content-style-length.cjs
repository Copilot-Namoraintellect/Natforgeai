require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  await conn.query(
    "ALTER TABLE campaigns MODIFY COLUMN contentStyle TEXT NULL"
  );

  const [cols] = await conn.query(
    "SHOW COLUMNS FROM campaigns WHERE Field = 'contentStyle'"
  );

  console.table(cols);

  await conn.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
