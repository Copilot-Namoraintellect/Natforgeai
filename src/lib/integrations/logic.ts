export interface ConnectedIntegration {
  id: number;
  platform: string;
  accountName?: string | null;
  status: string;
  ready?: boolean;
  businessId?: number | null;
  createdAt?: Date | string | null;
}

export type BusinessScopedStatus =
  | "connected_for_business"
  | "connected_other_business"
  | "connected_unassigned"
  | "disconnected";

export interface IntegrationForBusinessResult {
  status: BusinessScopedStatus;
  integration?: ConnectedIntegration;
}

export function integrationMatchesBusiness(
  integration: Pick<ConnectedIntegration, "businessId">,
  selectedBusinessId?: number | null
): boolean {
  if (selectedBusinessId == null) return true;
  if (integration.businessId == null) return true;
  return integration.businessId === selectedBusinessId;
}

export function getIntegrationForBusiness(
  platform: string,
  integrations: ConnectedIntegration[],
  selectedBusinessId?: number | null
): IntegrationForBusinessResult {
  const candidates = integrations.filter((i) => i.platform === platform);
  const connectedCandidates = candidates.filter((i) => i.status === "connected");

  if (connectedCandidates.length > 0) {
    const exactMatch = connectedCandidates.find(
      (i) => selectedBusinessId != null && i.businessId === selectedBusinessId
    );
    const unassignedMatch = connectedCandidates.find((i) => i.businessId == null);
    const match = exactMatch ?? unassignedMatch;

    if (match) {
      return {
        status: match.businessId == null ? "connected_unassigned" : "connected_for_business",
        integration: match,
      };
    }

    const fallback = connectedCandidates[0];
    return { status: "connected_other_business", integration: fallback };
  }

  return { status: "disconnected" };
}

export function getBusinessNameMap(businesses?: { id: number; name?: string | null }[]): Map<number, string> {
  const map = new Map<number, string>();
  if (!businesses) return map;
  for (const b of businesses) {
    map.set(b.id, b.name || `Business ${b.id}`);
  }
  return map;
}
