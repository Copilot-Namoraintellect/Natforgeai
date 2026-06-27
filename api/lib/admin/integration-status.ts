export interface IntegrationStatusRow {
  platform: string | null;
  status: string | null;
}

/**
 * Aggregate social integration rows into a `{ platform: { status: count } }` map,
 * as consumed by the Admin Diagnostics panel.
 */
export function aggregateIntegrationStatuses(
  rows: IntegrationStatusRow[]
): Record<string, Record<string, number>> {
  const integrations: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const platform = row.platform || "unknown";
    const status = row.status || "unknown";
    integrations[platform] = integrations[platform] || {};
    integrations[platform][status] = (integrations[platform][status] || 0) + 1;
  }
  return integrations;
}
