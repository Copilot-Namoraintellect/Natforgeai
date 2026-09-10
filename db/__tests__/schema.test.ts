import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

const schemaPath = resolve(__dirname, "../schema.ts");
const migrationPath = resolve(__dirname, "../migrations/0011_polite_tusk.sql");

describe("content_posts schema", () => {
  it("does not define imageUrl as a column on content_posts (image URL lives in metadata or campaign_assets)", () => {
    const schema = readFileSync(schemaPath, "utf8");
    // Extract the content_posts table definition block
    const match = schema.match(/export const contentPosts = mysqlTable\("content_posts",\s*\{[\s\S]*?\}\);/);
    expect(match).toBeTruthy();
    const contentPostsBlock = match?.[0] ?? "";
    expect(contentPostsBlock).toContain("metadata: json");
    expect(contentPostsBlock).not.toContain("imageUrl");
  });
});

describe("social_integrations schema", () => {
  it("defines instagramBusinessAccountId in the schema", () => {
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toContain("instagramBusinessAccountId");
  });

  it("has a committed migration adding instagramBusinessAccountId as varchar(255)", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toMatch(/instagramBusinessAccountId/i);
    expect(migration).toMatch(/varchar\s*\(\s*255\s*\)/i);
  });
});

describe("image_render_claims schema", () => {
  const imageRenderClaimsMigrationPath = resolve(
    __dirname,
    "../migrations/0018_nervous_swordsman.sql"
  );

  it("defines image_render_claims without any campaign identity", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const match = schema.match(
      /export const imageRenderClaims = mysqlTable\(\s*"image_render_claims",[\s\S]*?\n\);/
    );
    expect(match).toBeTruthy();
    const block = match?.[0] ?? "";
    expect(block).toContain("userId");
    expect(block).toContain("contentPostId");
    expect(block).toContain("activeClaimKey");
    expect(block).toContain("ownerToken");
    expect(block).toContain('mysqlEnum("status", ["running", "completed", "failed"])');
    expect(block).toContain("leaseExpiresAt");
    expect(block).not.toContain("campaignId");
    expect(block).not.toContain("attemptKey");
    expect(block).not.toContain("references(");
  });

  it("keeps activeClaimKey nullable with a unique index", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const match = schema.match(
      /export const imageRenderClaims = mysqlTable\(\s*"image_render_claims",[\s\S]*?\n\);/
    );
    const block = match?.[0] ?? "";
    expect(block).toMatch(/activeClaimKey: varchar\("activeClaimKey", \{ length: 191 \}\)(?!\.notNull)/);
    expect(block).toContain('uniqueIndex("irc_active_claim_key_idx")');
    expect(block).toContain('index("irc_user_post_idx")');
  });

  it("has a committed migration creating image_render_claims", () => {
    const migration = readFileSync(imageRenderClaimsMigrationPath, "utf8");
    expect(migration).toMatch(/CREATE TABLE `image_render_claims`/);
    expect(migration).toMatch(/`activeClaimKey` varchar\(191\)/);
    expect(migration).toMatch(/UNIQUE\(`activeClaimKey`\)/);
    expect(migration).toMatch(/CREATE INDEX `irc_user_post_idx`/);
    expect(migration).not.toMatch(/campaignId/i);
  });
});

describe("image_render_claims migration 0019 (request-attempt identity)", () => {
  const migration0019Path = resolve(__dirname, "../migrations/0019_cuddly_nicolaos.sql");

  function imageRenderClaimsBlock(): string {
    const schema = readFileSync(schemaPath, "utf8");
    const match = schema.match(
      /export const imageRenderClaims = mysqlTable\(\s*"image_render_claims",[\s\S]*?\n\);/
    );
    expect(match).toBeTruthy();
    return match?.[0] ?? "";
  }

  it("adds exactly the four identity columns to image_render_claims only", () => {
    const migration = readFileSync(migration0019Path, "utf8");
    expect(migration).toMatch(/ALTER TABLE `image_render_claims` ADD `requestAttemptKey` varchar\(64\)/);
    expect(migration).toMatch(/ALTER TABLE `image_render_claims` ADD `intentFingerprint` varchar\(64\)/);
    expect(migration).toMatch(/ALTER TABLE `image_render_claims` ADD `deductionKey` varchar\(191\)/);
    expect(migration).toMatch(/ADD `deductionRecorded` boolean DEFAULT false NOT NULL/);
    expect(migration).toMatch(/ADD CONSTRAINT `irc_request_attempt_key_idx` UNIQUE\(`requestAttemptKey`\)/);
    expect(migration).toMatch(/CREATE INDEX `irc_deduction_key_idx` ON `image_render_claims` \(`deductionKey`\)/);

    // No other table is touched, nothing is dropped, and no raw or billing
    // identity beyond the scoped digests is persisted.
    const statements = migration.split("--> statement-breakpoint").map((s) => s.trim());
    expect(statements.length).toBe(6);
    for (const statement of statements) {
      expect(statement).toMatch(/^(ALTER TABLE `image_render_claims`|CREATE INDEX `\w+` ON `image_render_claims`)/);
    }
    expect(migration).not.toMatch(/DROP/i);
    expect(migration).not.toMatch(/clientAttemptId/i);
    expect(migration).not.toMatch(/refundKey/i);
    expect(migration).not.toMatch(/campaign/i);
    expect(migration).not.toMatch(/refinementInstruction/i);
    expect(migration).not.toMatch(/creativeGuidance/i);
    // deductionKey index must be non-unique.
    expect(migration).not.toMatch(/UNIQUE\(`deductionKey`\)/);
  });

  it("keeps the identity columns nullable and deductionRecorded non-null in schema", () => {
    const block = imageRenderClaimsBlock();
    expect(block).toMatch(/requestAttemptKey: varchar\("requestAttemptKey", \{ length: 64 \}\)(?!\.notNull)/);
    expect(block).toMatch(/intentFingerprint: varchar\("intentFingerprint", \{ length: 64 \}\)(?!\.notNull)/);
    expect(block).toMatch(/deductionKey: varchar\("deductionKey", \{ length: 191 \}\)(?!\.notNull)/);
    expect(block).toContain('deductionRecorded: boolean("deductionRecorded").default(false).notNull()');
    expect(block).toContain('uniqueIndex("irc_request_attempt_key_idx")');
    expect(block).toContain('index("irc_deduction_key_idx")');
    expect(block).not.toContain("clientAttemptId");
    expect(block).not.toContain("refundKey");
    expect(block).not.toContain("campaignId");
    // Slice A structure is untouched.
    expect(block).toContain('uniqueIndex("irc_active_claim_key_idx")');
    expect(block).toContain('index("irc_user_post_idx")');
  });

  it("adds exactly one valid 0019 journal entry chained to 0018", () => {
    const journal = JSON.parse(
      readFileSync(resolve(__dirname, "../migrations/meta/_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string }[] };
    const entries19 = journal.entries.filter((entry) => entry.tag.startsWith("0019_"));
    expect(entries19).toHaveLength(1);
    expect(entries19[0].idx).toBe(19);

    const snapshot18 = JSON.parse(
      readFileSync(resolve(__dirname, "../migrations/meta/0018_snapshot.json"), "utf8")
    ) as { id: string };
    const snapshot19 = JSON.parse(
      readFileSync(resolve(__dirname, "../migrations/meta/0019_snapshot.json"), "utf8")
    ) as { id: string; prevId: string };
    expect(snapshot19.prevId).toBe(snapshot18.id);
  });

  it("snapshot 0019 contains only image_render_claims drift", () => {
    const snapshot18 = JSON.parse(
      readFileSync(resolve(__dirname, "../migrations/meta/0018_snapshot.json"), "utf8")
    ) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    const snapshot19 = JSON.parse(
      readFileSync(resolve(__dirname, "../migrations/meta/0019_snapshot.json"), "utf8")
    ) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };

    const tableNames18 = Object.keys(snapshot18.tables).sort();
    const tableNames19 = Object.keys(snapshot19.tables).sort();
    expect(tableNames19).toEqual(tableNames18);

    for (const tableName of tableNames18) {
      const before = snapshot18.tables[tableName];
      const after = snapshot19.tables[tableName];
      const addedColumns = Object.keys(after.columns).filter(
        (column) => !(column in before.columns)
      );
      const removedColumns = Object.keys(before.columns).filter(
        (column) => !(column in after.columns)
      );
      const addedIndexes = Object.keys(after.indexes).filter(
        (index) => !(index in before.indexes)
      );
      const removedIndexes = Object.keys(before.indexes).filter(
        (index) => !(index in after.indexes)
      );

      if (tableName === "image_render_claims") {
        expect(addedColumns.sort()).toEqual([
          "deductionKey",
          "deductionRecorded",
          "intentFingerprint",
          "requestAttemptKey",
        ]);
        expect(removedColumns).toEqual([]);
        expect(addedIndexes.sort()).toEqual(["irc_deduction_key_idx", "irc_request_attempt_key_idx"]);
        expect(removedIndexes).toEqual([]);
      } else {
        expect(addedColumns).toEqual([]);
        expect(removedColumns).toEqual([]);
        expect(addedIndexes).toEqual([]);
        expect(removedIndexes).toEqual([]);
      }
    }
  });
});

describe("image_render_claims migration 0020 (durable result linkage)", () => {
  const migrationsDir = resolve(__dirname, "../migrations");
  const metaDir = resolve(__dirname, "../migrations/meta");

  function migration0020Path(): string {
    const files = readdirSync(migrationsDir).filter(
      (file) => /^0020_\w+\.sql$/.test(file)
    );
    expect(files).toHaveLength(1);
    return resolve(migrationsDir, files[0]);
  }

  function imageRenderClaimsBlock(): string {
    const schema = readFileSync(schemaPath, "utf8");
    const match = schema.match(
      /export const imageRenderClaims = mysqlTable\(\s*"image_render_claims",[\s\S]*?\n\);/
    );
    expect(match).toBeTruthy();
    return match?.[0] ?? "";
  }

  it("defines exactly nine nullable result-linkage and replay snapshot columns", () => {
    const block = imageRenderClaimsBlock();
    expect(block).toMatch(
      /generatedImageId: bigint\("generatedImageId", \{ mode: "number", unsigned: true \}\)(?!\.notNull)/
    );
    expect(block).toMatch(/resultImageUrl: text\("resultImageUrl"\)(?!\.notNull)/);
    expect(block).toMatch(
      /resultProvider: varchar\("resultProvider", \{ length: 50 \}\)(?!\.notNull)/
    );
    expect(block).toMatch(
      /resultProviderJobId: varchar\("resultProviderJobId", \{ length: 255 \}\)(?!\.notNull)/
    );
    expect(block).toMatch(/resultCreditsCharged: int\("resultCreditsCharged"\)(?!\.notNull)/);
    expect(block).toMatch(
      /resultQualityTier: varchar\("resultQualityTier", \{ length: 50 \}\)(?!\.notNull)/
    );
    expect(block).toMatch(/resultQualityLabel: text\("resultQualityLabel"\)(?!\.notNull)/);
    expect(block).toMatch(/resultIsDraft: boolean\("resultIsDraft"\)(?!\.notNull)/);
    expect(block).toMatch(/completedAt: timestamp\("completedAt"\)(?!\.notNull)/);
  });

  it("adds the unique irc_generated_image_idx and preserves every prior index", () => {
    const block = imageRenderClaimsBlock();
    expect(block).toContain('uniqueIndex("irc_generated_image_idx")');
    expect(block).toContain('uniqueIndex("irc_active_claim_key_idx")');
    expect(block).toContain('uniqueIndex("irc_request_attempt_key_idx")');
    expect(block).toContain('index("irc_deduction_key_idx")');
    expect(block).toContain('index("irc_user_post_idx")');
    // No foreign keys, matching repository convention.
    expect(block).not.toContain("references(");
    expect(block).not.toContain("foreignKey");
    // generated_images schema is untouched by this change.
    const schema = readFileSync(schemaPath, "utf8");
    const generatedImagesMatch = schema.match(
      /export const generatedImages = mysqlTable\("generated_images", \{[\s\S]*?\n\}\);/
    );
    expect(generatedImagesMatch?.[0] ?? "").not.toContain("imageRenderClaim");
  });

  it("migration 0020 adds exactly nine columns and one unique constraint to image_render_claims only", () => {
    const migration = readFileSync(migration0020Path(), "utf8");

    expect(migration).toMatch(
      /ALTER TABLE `image_render_claims` ADD `generatedImageId` bigint unsigned/
    );
    expect(migration).toMatch(/ADD `resultImageUrl` text/);
    expect(migration).toMatch(/ADD `resultProvider` varchar\(50\)/);
    expect(migration).toMatch(/ADD `resultProviderJobId` varchar\(255\)/);
    expect(migration).toMatch(/ADD `resultCreditsCharged` int/);
    expect(migration).toMatch(/ADD `resultQualityTier` varchar\(50\)/);
    expect(migration).toMatch(/ADD `resultQualityLabel` text/);
    expect(migration).toMatch(/ADD `resultIsDraft` boolean/);
    expect(migration).toMatch(/ADD `completedAt` timestamp/);
    expect(migration).toMatch(
      /ADD CONSTRAINT `irc_generated_image_idx` UNIQUE\(`generatedImageId`\)/
    );

    const statements = migration
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements).toHaveLength(10);
    for (const statement of statements) {
      expect(statement).toMatch(/^ALTER TABLE `image_render_claims`/);
    }
    expect(migration).not.toMatch(/DROP/i);
    expect(migration).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(migration).not.toMatch(/NOT NULL/i);
    expect(migration).not.toMatch(/DEFAULT/i);
    // No defaults that would make a legacy row appear replayable.
    expect(migration).not.toMatch(/generatedImageId` bigint unsigned NOT NULL/i);
  });

  it("adds exactly one valid 0020 journal entry chained to 0019", () => {
    const journal = JSON.parse(
      readFileSync(resolve(metaDir, "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string }[] };
    const entries20 = journal.entries.filter((entry) => entry.tag.startsWith("0020_"));
    expect(entries20).toHaveLength(1);
    expect(entries20[0].idx).toBe(20);

    const snapshot19 = JSON.parse(
      readFileSync(resolve(metaDir, "0019_snapshot.json"), "utf8")
    ) as { id: string };
    const snapshot20 = JSON.parse(
      readFileSync(resolve(metaDir, "0020_snapshot.json"), "utf8")
    ) as { id: string; prevId: string };
    expect(snapshot20.prevId).toBe(snapshot19.id);
  });

  it("snapshot 0020 contains only image_render_claims drift", () => {
    const snapshot19 = JSON.parse(
      readFileSync(resolve(metaDir, "0019_snapshot.json"), "utf8")
    ) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };
    const snapshot20 = JSON.parse(
      readFileSync(resolve(metaDir, "0020_snapshot.json"), "utf8")
    ) as {
      tables: Record<string, { columns: Record<string, unknown>; indexes: Record<string, unknown> }>;
    };

    const tableNames19 = Object.keys(snapshot19.tables).sort();
    const tableNames20 = Object.keys(snapshot20.tables).sort();
    expect(tableNames20).toEqual(tableNames19);

    for (const tableName of tableNames19) {
      const before = snapshot19.tables[tableName];
      const after = snapshot20.tables[tableName];
      const addedColumns = Object.keys(after.columns).filter(
        (column) => !(column in before.columns)
      );
      const removedColumns = Object.keys(before.columns).filter(
        (column) => !(column in after.columns)
      );
      const addedIndexes = Object.keys(after.indexes).filter(
        (index) => !(index in before.indexes)
      );
      const removedIndexes = Object.keys(before.indexes).filter(
        (index) => !(index in after.indexes)
      );

      if (tableName === "image_render_claims") {
        expect(addedColumns.sort()).toEqual([
          "completedAt",
          "generatedImageId",
          "resultCreditsCharged",
          "resultImageUrl",
          "resultIsDraft",
          "resultProvider",
          "resultProviderJobId",
          "resultQualityLabel",
          "resultQualityTier",
        ]);
        expect(removedColumns).toEqual([]);
        expect(addedIndexes).toEqual(["irc_generated_image_idx"]);
        expect(removedIndexes).toEqual([]);
      } else {
        expect(addedColumns).toEqual([]);
        expect(removedColumns).toEqual([]);
        expect(addedIndexes).toEqual([]);
        expect(removedIndexes).toEqual([]);
      }
    }
  });

  it("leaves migrations 0018 and 0019 unchanged", () => {
    const migration18 = readFileSync(
      resolve(migrationsDir, "0018_nervous_swordsman.sql"),
      "utf8"
    );
    expect(migration18).toMatch(/CREATE TABLE `image_render_claims`/);
    expect(migration18).not.toMatch(/generatedImageId/);

    const migration19 = readFileSync(
      resolve(migrationsDir, "0019_cuddly_nicolaos.sql"),
      "utf8"
    );
    const statements19 = migration19
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements19).toHaveLength(6);
    expect(migration19).not.toMatch(/generatedImageId|resultImageUrl|completedAt/);

    const journal = JSON.parse(
      readFileSync(resolve(metaDir, "_journal.json"), "utf8")
    ) as { entries: { idx: number; tag: string }[] };
    expect(
      journal.entries.filter((entry) => entry.tag.startsWith("0018_"))
    ).toHaveLength(1);
    expect(
      journal.entries.filter((entry) => entry.tag.startsWith("0019_"))
    ).toHaveLength(1);
  });
});
