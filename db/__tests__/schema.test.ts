import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const schemaPath = resolve(__dirname, "../schema.ts");
const migrationPath = resolve(__dirname, "../migrations/0011_polite_tusk.sql");

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
