import type { TemplateRendererProvider, TemplateRendererRequest, TemplateRendererResult } from "./template-renderer";

export class PlaceholderTemplateRenderer implements TemplateRendererProvider {
  name = "placeholder";
  private providerName: string;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  get configured(): boolean {
    return false;
  }

  async render(_req: TemplateRendererRequest): Promise<TemplateRendererResult> {
    return {
      success: false,
      error: `Premium template provider ${this.providerName} is not configured. Add the provider API key to enable it, or generate a Basic Draft instead.`,
    };
  }
}
