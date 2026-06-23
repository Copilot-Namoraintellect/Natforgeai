require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [users] = await conn.query(
    "SELECT id, email, role, createdAt FROM users ORDER BY id DESC LIMIT 20"
  );

  console.table(users);

  await conn.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
