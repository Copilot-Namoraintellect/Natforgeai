import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGenerateObject = vi.fn();

vi.mock("ai", () => ({
  generateObject: (...args: any[]) => mockGenerateObject(...args),
}));

vi.mock("../../env", () => ({
  env: {
    openaiApiKey: "test-key",
    enableHybridLeafletPipeline: true,
  },
}));

import { planCreativeWithAI } from "./plan-ai";
import { CreativePlanOpenAISchema, BrandKitOpenAISchema } from "./pipeline-types";

function zodType(schema: any): string | undefined {
  return schema?._def?.typeName ?? schema?._def?.type;
}

function hasZodAny(schema: any): boolean {
  if (!schema || typeof schema !== "object") return false;
  const type = zodType(schema);
  if (type === "ZodAny" || type === "ZodUnknown") return true;
  if (type === "ZodObject") {
    const shape = typeof schema._def.shape === "function" ? schema._def.shape() : schema._def.shape;
    return Object.values(shape).some((value) => hasZodAny(value));
  }
  if (type === "ZodArray" || type === "array") {
    return hasZodAny(schema._def.type ?? schema.element);
  }
  if (type === "ZodNullable" || type === "ZodOptional" || type === "ZodDefault" || type === "nullable" || type === "optional") {
    return hasZodAny(schema._def.innerType ?? schema._def.schema);
  }
  if (type === "ZodUnion" || type === "ZodDiscriminatedUnion") {
    return schema._def.options.some((option: any) => hasZodAny(option));
  }
  if (type === "ZodEffects") {
    return hasZodAny(schema._def.schema);
  }
  return false;
}

function isZodObjectWithType(schema: any): boolean {
  return schema?.constructor?.name === "ZodObject" || zodType(schema) === "object" || zodType(schema) === "ZodObject";
}

describe("plan-ai OpenAI structured-output schema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has no ZodAny anywhere in the planner schema", () => {
    expect(hasZodAny(CreativePlanOpenAISchema)).toBe(false);
    expect(hasZodAny(BrandKitOpenAISchema)).toBe(false);
  });

  it("brandKit is a strict object schema with a top-level type", () => {
    expect(isZodObjectWithType(BrandKitOpenAISchema)).toBe(true);
  });

  it("does not ask OpenAI to emit the internal brandAsset field", () => {
    expect(BrandKitOpenAISchema.shape).not.toHaveProperty("brandAsset");
  });

  it("captures the exact schema passed to generateObject and validates it", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        brandKit: {
          primary: "#0047AB",
          secondary: "#DC2626",
          accent: "#F59E0B",
          background: "#FFFFFF",
          text: "#0F172A",
          textMuted: "#475569",
          source: "logo",
          logoUrl: null,
          logoDescription: null,
          typographyNote: null,
        },
        brief: {
          angle: "Fast printing",
          headline: "Print fast",
          subheadline: "Quality printing",
          primaryServices: [{ name: "Printing", description: "Fast", isPrimary: true }],
          secondaryServices: [],
          benefits: ["Fast"],
          cta: "Call",
          offerLine: null,
        },
        visualDirection: {
          layoutPreset: "premium_local_service",
          density: "balanced",
          heroTreatment: "solid_brand_block",
          backgroundDirection: "clean_white",
          backgroundPrompt: "white",
          ctaTreatment: "solid_button",
          colourUsageNote: "brand",
        },
      },
    });

    const business = {
      id: 20,
      name: "Test",
      displayName: "Test",
      industry: "Services",
      productOrService: "Printing",
      logo: "/uploads/logo/14/logo.png",
    };

    const result = await planCreativeWithAI(business as any);
    expect(result.usedOpenAI).toBe(true);
    expect(result.value.brandKit.brandAsset).toBeDefined();
    expect(result.value.brandKit.brandAsset?.logoSourceType).toBe("uploaded");

    const passedSchema = mockGenerateObject.mock.calls[0][0].schema;
    expect(hasZodAny(passedSchema)).toBe(false);
    expect(isZodObjectWithType(passedSchema)).toBe(true);
    const brandKitShape = passedSchema.shape.brandKit.shape;
    expect(brandKitShape).not.toHaveProperty("brandAsset");
  });

  it("injects the deterministic brandAsset when OpenAI planning fails", async () => {
    mockGenerateObject.mockRejectedValue(new Error("schema invalid"));

    const business = {
      id: 20,
      name: "Test",
      displayName: "Test",
      industry: "Services",
      productOrService: "Printing",
      logo: "/uploads/logo/14/logo.png",
    };

    const result = await planCreativeWithAI(business as any);
    expect(result.usedOpenAI).toBe(false);
    expect(result.value.brandKit.brandAsset).toBeDefined();
    expect(result.value.brandKit.brandAsset?.realLogoExpected).toBe(true);
  });
});
