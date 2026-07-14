export const CONTENT_GENERATION_CONNECTION_MESSAGE =
  "Content generation is taking longer than expected or the server connection was interrupted. No credits were charged. Check Agent Activity for the current status before retrying.";

export const CONTENT_GENERATION_QUEUE_FAILURE_MESSAGE =
  "Content generation could not be queued. No credits were charged. Please try again after the service issue is resolved.";

function collectErrorMessages(err: any): string[] {
  const visited = new Set<any>();
  const messages: string[] = [];

  const walk = (value: any) => {
    if (!value || visited.has(value)) return;
    if (typeof value === "string") {
      if (value.trim()) messages.push(value);
      return;
    }
    if (typeof value !== "object") return;
    visited.add(value);

    const direct = [value.message, value.error, value.details, value.reason];
    for (const item of direct) {
      if (typeof item === "string" && item.trim()) messages.push(item);
    }

    walk(value.cause);
    walk(value.data);
    walk(value.shape);
    walk(value.meta);
    walk(value.response);
    walk(value.originalError);
  };

  walk(err);
  return messages;
}

export function isUpstreamConnectionError(err: any): boolean {
  const combined = collectErrorMessages(err).join("\n");
  const message = String(combined || err?.message || "");
  const httpStatus =
    err?.data?.httpStatus ||
    err?.shape?.data?.httpStatus ||
    err?.meta?.response?.status ||
    err?.cause?.status;

  if ([502, 503, 504].includes(Number(httpStatus))) return true;

  return /unexpected token\s*'?</i.test(message)
    || /<!doctype/i.test(message)
    || /not valid json/i.test(message)
    || /unexpected end of json input/i.test(message)
    || /failed to fetch/i.test(message)
    || /networkerror/i.test(message)
    || /connection.*interrupted/i.test(message)
    || /upstream/i.test(message)
    || /gateway/i.test(message)
    || /terminated/i.test(message)
    || /abort/i.test(message);
}

export function formatContentGenerationError(err: any): string {
  const combined = collectErrorMessages(err).join("\n");
  if (/custom\s+id\s+cannot\s+contain\s*:/i.test(combined)) {
    return CONTENT_GENERATION_QUEUE_FAILURE_MESSAGE;
  }
  if (isUpstreamConnectionError(err)) {
    return CONTENT_GENERATION_CONNECTION_MESSAGE;
  }
  return err?.message || "Failed to generate content for campaign";
}
