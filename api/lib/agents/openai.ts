import { createOpenAI } from "@ai-sdk/openai";
import { env } from "../env";

const openai = createOpenAI({ apiKey: env.openaiApiKey || undefined });

export const defaultModel = openai("gpt-4o-mini");
export const structuredModel = openai("gpt-4o-mini");
