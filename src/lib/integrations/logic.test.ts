import { describe, it, expect } from "vitest";
import {
  integrationMatchesBusiness,
  getIntegrationForBusiness,
  getBusinessNameMap,
} from "./logic";

describe("integrationMatchesBusiness", () => {
  it("matches when no business is selected", () => {
    expect(integrationMatchesBusiness({ businessId: 5 }, null)).toBe(true);
    expect(integrationMatchesBusiness({ businessId: null }, undefined)).toBe(true);
  });

  it("matches unassigned integrations for any selected business", () => {
    expect(integrationMatchesBusiness({ businessId: null }, 3)).toBe(true);
  });

  it("matches when integration belongs to the selected business", () => {
    expect(integrationMatchesBusiness({ businessId: 7 }, 7)).toBe(true);
  });

  it("does not match when integration belongs to a different business", () => {
    expect(integrationMatchesBusiness({ businessId: 7 }, 3)).toBe(false);
  });
});

describe("getIntegrationForBusiness", () => {
  const base = {
    id: 1,
    platform: "instagram",
    accountName: "testbrand",
    status: "connected",
    ready: true,
  };

  it("returns disconnected when there are no integrations", () => {
    expect(getIntegrationForBusiness("instagram", [], 5)).toEqual({ status: "disconnected" });
  });

  it("returns connected_for_business when a business-scoped integration matches", () => {
    const integrations = [{ ...base, id: 1, businessId: 5 }];
    expect(getIntegrationForBusiness("instagram", integrations, 5)).toEqual({
      status: "connected_for_business",
      integration: integrations[0],
    });
  });

  it("returns connected_unassigned when an unassigned integration matches the selected business", () => {
    const integrations = [{ ...base, id: 1, businessId: null }];
    expect(getIntegrationForBusiness("instagram", integrations, 5)).toEqual({
      status: "connected_unassigned",
      integration: integrations[0],
    });
  });

  it("returns connected_other_business when only a different business is connected", () => {
    const integrations = [{ ...base, id: 1, businessId: 7 }];
    expect(getIntegrationForBusiness("instagram", integrations, 5)).toEqual({
      status: "connected_other_business",
      integration: integrations[0],
    });
  });

  it("prefers the matching integration when both matching and other-business rows exist", () => {
    const matching = { ...base, id: 1, businessId: 5 };
    const other = { ...base, id: 2, businessId: 7 };
    expect(getIntegrationForBusiness("instagram", [other, matching], 5)).toEqual({
      status: "connected_for_business",
      integration: matching,
    });
  });

  it("prefers the business-specific match over an unassigned integration for the same business", () => {
    const unassigned = { ...base, id: 1, businessId: null };
    const specific = { ...base, id: 2, businessId: 5 };
    expect(getIntegrationForBusiness("instagram", [unassigned, specific], 5)).toEqual({
      status: "connected_for_business",
      integration: specific,
    });
  });
});

describe("getBusinessNameMap", () => {
  it("maps business ids to names", () => {
    const map = getBusinessNameMap([
      { id: 1, name: "Zuto Hub" },
      { id: 2, name: "Acme Inc" },
    ]);
    expect(map.get(1)).toBe("Zuto Hub");
    expect(map.get(2)).toBe("Acme Inc");
  });

  it("returns an empty map when no businesses are provided", () => {
    expect(getBusinessNameMap(undefined).size).toBe(0);
  });
});
