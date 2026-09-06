import sharp from "sharp";

import { evaluateTrustedRenderedCreative } from "./rendered-creative-evaluator";
import type { RenderedCreativeEvidence } from "./premium-rubric";
import type { V2RenderLayoutMetrics } from "../premium-v2/renderer";

export function createRenderLayoutMetrics(
  overrides: Partial<V2RenderLayoutMetrics> = {}
): V2RenderLayoutMetrics {
  return {
    width: 1200,
    height: 628,
    ctaBoundingBox: { x: 500, y: 500, w: 180, h: 54 },
    footerY: 520,
    footerHeight: 54,
    minFontSizeUsed: 20,
    primaryCardCount: 3,
    secondaryCardCount: 0,
    layoutDensity: "premium_services",
    didCrowd: false,
    logoComposited: false,
    usedContentHeight: 400,
    availableContentHeight: 500,
    primaryWithDescriptionCount: 0,
    ...overrides,
  };
}

export async function createTrustedRenderedCreativeEvidence(
  metrics: V2RenderLayoutMetrics = createRenderLayoutMetrics()
): Promise<RenderedCreativeEvidence> {
  const renderedBytes = await sharp({
    create: { width: metrics.width, height: metrics.height, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const result = await evaluateTrustedRenderedCreative({ renderedBytes, layoutMetrics: metrics });
  if (!result.accepted) {
    throw new Error(`Test render evidence rejected: ${result.reasonCodes.join(", ")}`);
  }
  return result.evidence;
}