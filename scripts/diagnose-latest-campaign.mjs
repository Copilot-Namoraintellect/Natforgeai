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

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.MYSQL_URL ||
  process.env.DB_URL;

if (!databaseUrl) {
  console.error("No DATABASE_URL, MYSQL_URL, or DB_URL found.");
  process.exit(1);
}

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [tableName]
  );
  return rows.length > 0;
}

async function getColumns(conn, tableName) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
  return rows.map((r) => r.Field);
}

function pick(cols, preferred) {
  return preferred.filter((c) => cols.includes(c));
}

async function printLatest(conn, tableName, whereSql = "", params = []) {
  if (!(await tableExists(conn, tableName))) {
    console.log(`\nTable not found: ${tableName}`);
    return;
  }

  const cols = await getColumns(conn, tableName);
  const selected = pick(cols, [
    "id",
    "campaignId",
    "userId",
    "businessId",
    "title",
    "name",
    "campaignName",
    "agentType",
    "type",
    "status",
    "workflowState",
    "currentStage",
    "error",
    "errorMessage",
    "result",
    "output",
    "createdAt",
    "updatedAt",
    "completedAt",
  ]);

  if (selected.length === 0) {
    console.log(`\n${tableName}: no common columns found`);
    return;
  }

  const orderCol = cols.includes("id") ? "id" : selected[0];

  const [rows] = await conn.query(
    `
    SELECT ${selected.map((c) => `\`${c}\``).join(", ")}
    FROM \`${tableName}\`
    ${whereSql}
    ORDER BY \`${orderCol}\` DESC
    LIMIT 10
    `,
    params
  );

  console.log(`\n--- ${tableName} ---`);
  console.dir(rows, { depth: 5 });
}

async function main() {
  const conn = await mysql.createConnection(databaseUrl);

  console.log("\nLatest campaigns:");
  await printLatest(conn, "campaigns");

  const [latestCampaigns] = await conn.query(
    `
    SELECT id
    FROM campaigns
    ORDER BY id DESC
    LIMIT 1
    `
  );

  const latestCampaignId = latestCampaigns?.[0]?.id;

  if (latestCampaignId) {
    console.log(`\nLatest campaign id: ${latestCampaignId}`);

    const possibleRelatedTables = [
      "agent_runs",
      "agentRuns",
      "approvals",
      "approval_requests",
      "content_posts",
      "contentPosts",
      "campaign_assets",
      "campaignAssets",
    ];

    for (const table of possibleRelatedTables) {
      if (!(await tableExists(conn, table))) continue;
      const cols = await getColumns(conn, table);
      if (cols.includes("campaignId")) {
        await printLatest(conn, table, "WHERE `campaignId` = ?", [latestCampaignId]);
      }
    }
  }

  console.log("\nTables containing agent/approval/content:");
  const [tables] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND (
        TABLE_NAME LIKE '%agent%'
        OR TABLE_NAME LIKE '%approval%'
        OR TABLE_NAME LIKE '%content%'
        OR TABLE_NAME LIKE '%campaign%'
      )
    ORDER BY TABLE_NAME
    `
  );
  console.dir(tables, { depth: 3 });

  await conn.end();
}

main().catch((err) => {
  console.error("\nDiagnostic failed:");
  console.error(err);
  process.exit(1);
});
