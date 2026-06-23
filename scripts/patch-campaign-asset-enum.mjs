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

const conn = await mysql.createConnection(databaseUrl);

try {
  const [before] = await conn.query(
    "SHOW COLUMNS FROM campaign_assets LIKE 'assetType'"
  );

  console.log("Before:");
  console.table(before);

  const sql = [
    "ALTER TABLE campaign_assets",
    "MODIFY COLUMN assetType ENUM(",
    "'image',",
    "'video_script',",
    "'carousel',",
    "'ad_copy',",
    "'caption',",
    "'caption_adaptation',",
    "'caption_pack',",
    "'hashtag_set',",
    "'cta_variant',",
    "'email_copy',",
    "'whatsapp_copy',",
    "'video_concept',",
    "'reel_script',",
    "'carousel_ad',",
    "'whatsapp_promo',",
    "'lead_gen_ad',",
    "'launch_pack'",
    ") NOT NULL"
  ].join(" ");

  await conn.query(sql);

  const [after] = await conn.query(
    "SHOW COLUMNS FROM campaign_assets LIKE 'assetType'"
  );

  console.log("After:");
  console.table(after);

  console.log("campaign_assets.assetType enum patched safely.");
} finally {
  await conn.end();
}
