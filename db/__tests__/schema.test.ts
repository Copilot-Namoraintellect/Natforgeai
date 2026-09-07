import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
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
