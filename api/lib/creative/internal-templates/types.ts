import type { BrandPalette } from "../brand-palette";
import type { PremiumTemplateId } from "../template-catalogue";

export interface InternalTemplateRenderContext {
  templateId: PremiumTemplateId;
  width: number;
  height: number;
  businessName: string;
  logoBuffer: Buffer | null;
  brandPalette: BrandPalette;
  headline: string;
  offer: string;
  subheadline?: string;
  cta: string;
  services: string[];
  contact: {
    phone?: string;
    whatsapp?: string;
    website?: string;
    email?: string;
    location?: string;
  };
  creativeGuidance?: string;
  refinementInstruction?: string;
  visualHints?: import("../composition").LayoutHints;
}

export interface InternalTemplateLayout {
  id: PremiumTemplateId;
  render(ctx: InternalTemplateRenderContext): Promise<Buffer>;
}
