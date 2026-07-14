import { describe, expect, it } from "vitest";
import {
  CONTENT_GENERATION_CONNECTION_MESSAGE,
  CONTENT_GENERATION_QUEUE_FAILURE_MESSAGE,
  formatContentGenerationError,
  isUpstreamConnectionError,
} from "./content-generation-errors";

describe("content generation error formatting", () => {
  it("maps HTML 502 parse failures to a user-friendly message", () => {
    const err = {
      message: "Unexpected token '<', '<!DOCTYPE html>' is not valid JSON",
      data: { httpStatus: 502 },
    };

    expect(isUpstreamConnectionError(err)).toBe(true);
    expect(formatContentGenerationError(err)).toBe(CONTENT_GENERATION_CONNECTION_MESSAGE);
    expect(formatContentGenerationError(err)).not.toContain("Unexpected token '<'");
  });

  it("keeps regular API errors unchanged", () => {
    const err = { message: "Campaign not found" };
    expect(isUpstreamConnectionError(err)).toBe(false);
    expect(formatContentGenerationError(err)).toBe("Campaign not found");
  });

  it("maps 503/504 upstream interruptions to the same friendly message", () => {
    const err503 = {
      message: "Service Unavailable",
      data: { httpStatus: 503 },
    };
    const err504 = {
      message: "Gateway Timeout",
      data: { httpStatus: 504 },
    };

    expect(isUpstreamConnectionError(err503)).toBe(true);
    expect(formatContentGenerationError(err503)).toBe(CONTENT_GENERATION_CONNECTION_MESSAGE);
    expect(isUpstreamConnectionError(err504)).toBe(true);
    expect(formatContentGenerationError(err504)).toBe(CONTENT_GENERATION_CONNECTION_MESSAGE);
  });

  it("maps non-JSON parse interruptions to friendly message even without explicit status", () => {
    const err = {
      message: "Unexpected end of JSON input while parsing response",
    };

    expect(isUpstreamConnectionError(err)).toBe(true);
    expect(formatContentGenerationError(err)).toBe(CONTENT_GENERATION_CONNECTION_MESSAGE);
  });

  it("maps nested html/json parse errors without status to friendly message", () => {
    const err = {
      message: "Request failed",
      cause: {
        message: "Unexpected token '<', '<!DOCTYPE html>' is not valid JSON",
      },
    };

    expect(isUpstreamConnectionError(err)).toBe(true);
    expect(formatContentGenerationError(err)).toBe(CONTENT_GENERATION_CONNECTION_MESSAGE);
  });

  it("sanitizes BullMQ custom ID infrastructure errors", () => {
    const err = {
      message: "Custom Id cannot contain :",
    };

    expect(formatContentGenerationError(err)).toBe(CONTENT_GENERATION_QUEUE_FAILURE_MESSAGE);
    expect(formatContentGenerationError(err)).not.toContain("Custom Id cannot contain");
  });
});
