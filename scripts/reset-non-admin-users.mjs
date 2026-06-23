import fs from "fs";
import mysql from "mysql2/promise";

function loadEnvFile(path) {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(".env.production");
loadEnvFile(".env");

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const execute = args.includes("--execute");

const keepIdArg = args.find((a) => a.startsWith("--keep-id="));
const keepEmailArg = args.find((a) => a.startsWith("--keep-email="));

const keepUserId = keepIdArg ? Number(keepIdArg.split("=")[1]) : Number(process.env.KEEP_USER_ID || 0);
const keepEmail = keepEmailArg ? keepEmailArg.split("=").slice(1).join("=") : process.env.KEEP_USER_EMAIL;

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.MYSQL_URL ||
  process.env.DB_URL;

if (!databaseUrl) {
  console.error("No DATABASE_URL, MYSQL_URL, or DB_URL found. Check .env.production or machine environment variables.");
  process.exit(1);
}

function q(identifier) {
  return "`" + String(identifier).replace(/`/g, "``") + "`";
}

function firstExisting(cols, candidates) {
  return candidates.find((c) => cols.includes(c));
}

async function getColumns(conn, table) {
  const [rows] = await conn.query(
    `
    SELECT COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    ORDER BY ORDINAL_POSITION
    `,
    [table]
  );
  return rows.map((r) => r.COLUMN_NAME);
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [table]
  );
  return rows.length > 0;
}

async function getAllTables(conn) {
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_TYPE = 'BASE TABLE'
    ORDER BY TABLE_NAME
    `
  );
  return rows.map((r) => r.TABLE_NAME);
}

function placeholders(values) {
  return values.map(() => "?").join(",");
}

async function main() {
  const conn = await mysql.createConnection(databaseUrl);

  try {
    if (!(await tableExists(conn, "users"))) {
      throw new Error("Could not find users table.");
    }

    const userCols = await getColumns(conn, "users");
    const displayCols = [
      "id",
      "email",
      "username",
      "name",
      "role",
      "isAdmin",
      "isSuperAdmin",
      "onboardingComplete",
      "createdAt"
    ].filter((c) => userCols.includes(c));

    if (!displayCols.includes("id")) {
      throw new Error("users table does not have an id column.");
    }

    if (listOnly) {
      const [users] = await conn.query(
        `SELECT ${displayCols.map(q).join(", ")} FROM ${q("users")} ORDER BY ${q("id")}`
      );
      console.table(users);
      console.log("");
      console.log("Choose the super administrator id, then run:");
      console.log("node .\\scripts\\reset-non-admin-users.mjs --keep-id=SUPER_ADMIN_ID");
      console.log("Then, only after checking the dry run, run:");
      console.log("node .\\scripts\\reset-non-admin-users.mjs --keep-id=SUPER_ADMIN_ID --execute");
      return;
    }

    let keeper;
    if (keepUserId) {
      const [rows] = await conn.query(
        `SELECT ${displayCols.map(q).join(", ")} FROM ${q("users")} WHERE ${q("id")} = ?`,
        [keepUserId]
      );
      keeper = rows[0];
    } else if (keepEmail && userCols.includes("email")) {
      const [rows] = await conn.query(
        `SELECT ${displayCols.map(q).join(", ")} FROM ${q("users")} WHERE LOWER(${q("email")}) = LOWER(?)`,
        [keepEmail]
      );
      keeper = rows[0];
    }

    if (!keeper) {
      throw new Error("Keeper user not found. Run with --list first and use --keep-id=SUPER_ADMIN_ID.");
    }

    const [nonAdminUsers] = await conn.query(
      `SELECT ${q("id")} FROM ${q("users")} WHERE ${q("id")} <> ?`,
      [keeper.id]
    );
    const nonAdminUserIds = nonAdminUsers.map((u) => u.id);

    const allTables = await getAllTables(conn);

    const tableCols = {};
    for (const table of allTables) {
      tableCols[table] = await getColumns(conn, table);
    }

    let nonAdminBusinessIds = [];
    if (allTables.includes("businesses")) {
      const cols = tableCols["businesses"];
      const businessUserCol = firstExisting(cols, ["userId", "user_id", "ownerId", "owner_id"]);
      if (businessUserCol && nonAdminUserIds.length) {
        const [rows] = await conn.query(
          `SELECT ${q("id")} FROM ${q("businesses")} WHERE ${q(businessUserCol)} IN (${placeholders(nonAdminUserIds)})`,
          nonAdminUserIds
        );
        nonAdminBusinessIds = rows.map((r) => r.id);
      }
    }

    let nonAdminCampaignIds = [];
    if (allTables.includes("campaigns")) {
      const cols = tableCols["campaigns"];
      const campaignUserCol = firstExisting(cols, ["userId", "user_id", "ownerId", "owner_id", "createdBy", "created_by"]);
      const campaignBusinessCol = firstExisting(cols, ["businessId", "business_id"]);

      const conditions = [];
      const params = [];

      if (campaignUserCol && nonAdminUserIds.length) {
        conditions.push(`${q(campaignUserCol)} IN (${placeholders(nonAdminUserIds)})`);
        params.push(...nonAdminUserIds);
      }

      if (campaignBusinessCol && nonAdminBusinessIds.length) {
        conditions.push(`${q(campaignBusinessCol)} IN (${placeholders(nonAdminBusinessIds)})`);
        params.push(...nonAdminBusinessIds);
      }

      if (conditions.length) {
        const [rows] = await conn.query(
          `SELECT ${q("id")} FROM ${q("campaigns")} WHERE ${conditions.join(" OR ")}`,
          params
        );
        nonAdminCampaignIds = rows.map((r) => r.id);
      }
    }

    const deletePlans = [];

    for (const table of allTables) {
      if (table === "users") continue;

      const cols = tableCols[table];

      const campaignCol = firstExisting(cols, ["campaignId", "campaign_id"]);
      const businessCol = firstExisting(cols, ["businessId", "business_id"]);
      const userCol = firstExisting(cols, ["userId", "user_id", "ownerId", "owner_id", "createdBy", "created_by"]);

      if (campaignCol && nonAdminCampaignIds.length) {
        deletePlans.push({
          table,
          where: `${q(campaignCol)} IN (${placeholders(nonAdminCampaignIds)})`,
          params: nonAdminCampaignIds,
          reason: `campaign link via ${campaignCol}`
        });
      }

      if (businessCol && nonAdminBusinessIds.length) {
        deletePlans.push({
          table,
          where: `${q(businessCol)} IN (${placeholders(nonAdminBusinessIds)})`,
          params: nonAdminBusinessIds,
          reason: `business link via ${businessCol}`
        });
      }

      if (userCol && nonAdminUserIds.length) {
        deletePlans.push({
          table,
          where: `${q(userCol)} IN (${placeholders(nonAdminUserIds)})`,
          params: nonAdminUserIds,
          reason: `user link via ${userCol}`
        });
      }
    }

    deletePlans.push({
      table: "users",
      where: `${q("id")} <> ?`,
      params: [keeper.id],
      reason: "delete all users except keeper"
    });

    console.log("");
    console.log("KEEPING SUPER ADMIN:");
    console.table([keeper]);

    console.log("");
    console.log("TO DELETE:");
    console.log(`Users to delete: ${nonAdminUserIds.length}`);
    console.log(`Businesses to delete: ${nonAdminBusinessIds.length}`);
    console.log(`Campaigns to delete: ${nonAdminCampaignIds.length}`);

    console.log("");
    console.log("DELETE PLAN:");
    for (const plan of deletePlans) {
      const [countRows] = await conn.query(
        `SELECT COUNT(*) AS count FROM ${q(plan.table)} WHERE ${plan.where}`,
        plan.params
      );
      const count = countRows[0]?.count ?? 0;
      console.log(`${plan.table}: ${count} rows (${plan.reason})`);
    }

    if (!execute) {
      console.log("");
      console.log("DRY RUN ONLY. Nothing was deleted.");
      console.log("To execute, run the same command with --execute.");
      return;
    }

    console.log("");
    console.log("EXECUTING DELETE...");

    await conn.beginTransaction();

    try {
      await conn.query("SET FOREIGN_KEY_CHECKS = 0");

      for (const plan of deletePlans) {
        const [result] = await conn.query(
          `DELETE FROM ${q(plan.table)} WHERE ${plan.where}`,
          plan.params
        );
        console.log(`Deleted ${result.affectedRows} rows from ${plan.table}`);
      }

      await conn.query("SET FOREIGN_KEY_CHECKS = 1");
      await conn.commit();

      console.log("");
      console.log("Cleanup complete.");
    } catch (err) {
      await conn.query("SET FOREIGN_KEY_CHECKS = 1");
      await conn.rollback();
      throw err;
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error("");
  console.error("Cleanup failed:");
  console.error(err);
  process.exit(1);
});
