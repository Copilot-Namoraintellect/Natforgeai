import { describe, expect, it } from "vitest";
import { zodSchema } from "ai";
import type { z } from "zod";
import {
  BrandKitOpenAISchema,
  AICreativeBriefSchema,
  VisualDirectionSchema,
  CreativePlanOpenAISchema,
  VisionCriticResultSchema,
} from "./pipeline-types";
import { LogoCropCriticResultSchema } from "./vision-critic";

const SCHEMAS = [
  { name: "BrandKitOpenAISchema", schema: BrandKitOpenAISchema },
  { name: "AICreativeBriefSchema", schema: AICreativeBriefSchema },
  { name: "VisualDirectionSchema", schema: VisualDirectionSchema },
  { name: "CreativePlanOpenAISchema", schema: CreativePlanOpenAISchema },
  { name: "VisionCriticResultSchema", schema: VisionCriticResultSchema },
  { name: "LogoCropCriticResultSchema", schema: LogoCropCriticResultSchema },
];

function getJsonSchema(zod: z.ZodTypeAny): any {
  return (zodSchema(zod) as any).jsonSchema;
}

function validateStrictObject(node: any, path: string): string[] {
  const issues: string[] = [];
  if (!node || typeof node !== "object") return issues;

  if (node.type === "object" || (node.properties && typeof node.properties === "object")) {
    const keys = Object.keys(node.properties || {});
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of keys) {
      if (!required.includes(key)) {
        issues.push(`${path}: property "${key}" is missing from required`);
      }
    }
    if (node.additionalProperties !== false) {
      issues.push(`${path}: additionalProperties is not false`);
    }
    for (const [key, child] of Object.entries(node.properties || {})) {
      issues.push(...validateStrictObject(child, `${path}.${key}`));
    }
  }

  if (node.type === "array" && node.items) {
    issues.push(...validateStrictObject(node.items, `${path}[]`));
  }

  if (Array.isArray(node.anyOf)) {
    for (let i = 0; i < node.anyOf.length; i++) {
      issues.push(...validateStrictObject(node.anyOf[i], `${path}.anyOf[${i}]`));
    }
  }

  if (Array.isArray(node.allOf)) {
    for (let i = 0; i < node.allOf.length; i++) {
      issues.push(...validateStrictObject(node.allOf[i], `${path}.allOf[${i}]`));
    }
  }

  if (node.$ref && typeof node.$ref === "string") {
    // References are resolved inline by the AI SDK when sent to OpenAI; we
    // validate the concrete definitions through the rest of the tree.
  }

  return issues;
}

describe("OpenAI structured-output schema strictness", () => {
  for (const { name, schema } of SCHEMAS) {
    it(`${name} has every property in required and additionalProperties=false`, () => {
      const jsonSchema = getJsonSchema(schema);
      const issues = validateStrictObject(jsonSchema, name);
      expect(issues).toEqual([]);
    });
  }

  it("VisualDirectionSchema includes serviceLayout in required", () => {
    const jsonSchema = getJsonSchema(VisualDirectionSchema);
    expect(jsonSchema.required).toContain("serviceLayout");
  });
});
