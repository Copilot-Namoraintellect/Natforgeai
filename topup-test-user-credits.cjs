require("dotenv").config();
const mysql = require("mysql2/promise");

async function main() {
  const email = process.env.TOPUP_EMAIL;
  const amount = Number(process.env.TOPUP_AMOUNT || "100");

  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not found in .env");
  if (!email) throw new Error("TOPUP_EMAIL is required");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("TOPUP_AMOUNT must be a positive number");

  const conn = await mysql.createConnection(process.env.DATABASE_URL);

  const [users] = await conn.query(
    "SELECT id, email, role FROM users WHERE email = ?",
    [email]
  );

  if (!users.length) {
    throw new Error(`User not found: ${email}`);
  }

  const user = users[0];
  console.log("Target user:", user);

  const [tableRows] = await conn.query("SHOW TABLES");
  const tableNames = tableRows.map(row => Object.values(row)[0]);

  let walletTable = null;
  let walletColumns = [];

  for (const table of tableNames) {
    const [cols] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
    const fields = cols.map(c => c.Field);

    const hasUserId = fields.includes("userId") || fields.includes("user_id");
    const hasBalance = fields.includes("balance");

    if (hasUserId && hasBalance && /wallet|credit/i.test(table)) {
      walletTable = table;
      walletColumns = fields;
      break;
    }
  }

  if (!walletTable) {
    console.log("Available tables:", tableNames);
    throw new Error("Could not find wallet/credit table with userId and balance columns.");
  }

  const userIdColumn = walletColumns.includes("userId") ? "userId" : "user_id";

  console.log("Wallet table:", walletTable);
  console.log("Wallet columns:", walletColumns);

  const [beforeRows] = await conn.query(
    `SELECT * FROM \`${walletTable}\` WHERE \`${userIdColumn}\` = ?`,
    [user.id]
  );

  if (!beforeRows.length) {
    throw new Error(`No wallet found for userId ${user.id}. Login/allocate credits first, or create wallet through the app.`);
  }

  console.log("Before:");
  console.table(beforeRows);

  const updates = ["`balance` = `balance` + ?"];
  const params = [amount];

  if (walletColumns.includes("lifetimeEarned")) {
    updates.push("`lifetimeEarned` = `lifetimeEarned` + ?");
    params.push(amount);
  }

  if (walletColumns.includes("remainingThisMonth")) {
    updates.push("`remainingThisMonth` = `remainingThisMonth` + ?");
    params.push(amount);
  }

  if (walletColumns.includes("updatedAt")) {
    updates.push("`updatedAt` = NOW()");
  }

  params.push(user.id);

  await conn.query(
    `UPDATE \`${walletTable}\` SET ${updates.join(", ")} WHERE \`${userIdColumn}\` = ?`,
    params
  );

  const [afterRows] = await conn.query(
    `SELECT * FROM \`${walletTable}\` WHERE \`${userIdColumn}\` = ?`,
    [user.id]
  );

  console.log("After:");
  console.table(afterRows);

  await conn.end();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
