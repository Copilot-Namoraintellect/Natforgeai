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

const execute = process.argv.includes("--execute");

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

async function getColumnType(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `
    SELECT COLUMN_TYPE
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    `,
    [tableName, columnName]
  );
  return rows[0]?.COLUMN_TYPE || null;
}

async function main() {
  const conn = await mysql.createConnection(databaseUrl);

  const statements = [];

  const currentAssetType = await getColumnType(conn, "campaign_assets", "assetType");

  if (!currentAssetType) {
    throw new Error("Could not find campaign_assets.assetType column.");
  }

  if (!currentAssetType.includes("caption_adaptation")) {
    statements.push({
      label: "Add caption_adaptation to campaign_assets.assetType enum",
      sql: `
        ALTER TABLE \`campaign_assets\`
        MODIFY COLUMN \`assetType\` ENUM(
          'image',
          'video_script',
          'carousel',
          'ad_copy',
          'caption',
          'caption_adaptation',
          'hashtag_set',
          'cta_variant',
          'email_copy',
          'whatsapp_copy',
          'video_concept',
          'reel_script',
          'carousel_ad',
          'whatsapp_promo',
          'lead_gen_ad',
          'launch_pack'
        ) NOT NULL
      `,
    });
  }

  if (!(await tableExists(conn, "video_render_jobs"))) {
    statements.push({
      label: "Create video_render_jobs table",
      sql: `
        CREATE TABLE \`video_render_jobs\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`userId\` BIGINT UNSIGNED NOT NULL,
          \`campaignId\` BIGINT UNSIGNED NOT NULL,
          \`contentPostId\` BIGINT UNSIGNED NULL,
          \`provider\` VARCHAR(50) NOT NULL DEFAULT 'placeholder',
          \`renderJobId\` VARCHAR(255) NULL,
          \`renderStatus\` ENUM('queued','rendering','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
          \`videoUrl\` TEXT NULL,
          \`thumbnailUrl\` TEXT NULL,
          \`errorMessage\` TEXT NULL,
          \`creditCost\` INT NOT NULL DEFAULT 0,
          \`requestedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`completedAt\` TIMESTAMP NULL,
          \`createdBy\` BIGINT UNSIGNED NOT NULL,
          \`metadata\` JSON NULL,
          \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`)
        )
      `,
    });
  }

  if (!(await tableExists(conn, "two_factor_challenges"))) {
    statements.push({
      label: "Create two_factor_challenges table",
      sql: `
        CREATE TABLE \`two_factor_challenges\` (
          \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          \`userId\` BIGINT UNSIGNED NOT NULL,
          \`challengeToken\` VARCHAR(255) NOT NULL,
          \`otpHash\` VARCHAR(255) NOT NULL,
          \`expiresAt\` TIMESTAMP NOT NULL,
          \`attempts\` INT NOT NULL DEFAULT 0,
          \`maxAttempts\` INT NOT NULL DEFAULT 5,
          \`consumedAt\` TIMESTAMP NULL,
          \`sentToEmail\` VARCHAR(320) NOT NULL,
          \`ipAddress\` VARCHAR(45) NULL,
          \`userAgent\` TEXT NULL,
          \`createdAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          \`updatedAt\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`),
          UNIQUE KEY \`two_factor_challenges_challengeToken_unique\` (\`challengeToken\`)
        )
      `,
    });
  }

  console.log("");
  console.log("Batch 4 schema plan:");
  if (statements.length === 0) {
    console.log("No changes needed. Schema already up to date.");
  } else {
    for (const s of statements) {
      console.log(`- ${s.label}`);
    }
  }

  if (!execute) {
    console.log("");
    console.log("DRY RUN ONLY. Nothing was changed.");
    console.log("To apply, run:");
    console.log("node .\\scripts\\apply-batch4-schema.mjs --execute");
    await conn.end();
    return;
  }

  console.log("");
  console.log("Applying schema changes...");

  for (const s of statements) {
    console.log(`Applying: ${s.label}`);
    await conn.query(s.sql);
  }

  const finalAssetType = await getColumnType(conn, "campaign_assets", "assetType");
  const videoExists = await tableExists(conn, "video_render_jobs");
  const twoFactorExists = await tableExists(conn, "two_factor_challenges");

  console.log("");
  console.log("Verification:");
  console.log(`caption_adaptation enum exists: ${finalAssetType?.includes("caption_adaptation")}`);
  console.log(`video_render_jobs exists: ${videoExists}`);
  console.log(`two_factor_challenges exists: ${twoFactorExists}`);

  await conn.end();
  console.log("");
  console.log("Batch 4 schema changes complete.");
}

main().catch((err) => {
  console.error("");
  console.error("Batch 4 schema update failed:");
  console.error(err);
  process.exit(1);
});
