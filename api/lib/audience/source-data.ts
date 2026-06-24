export interface AudienceSourceDataCounts {
  integrations: number;
  profiles: number;
  events: number;
  signals: number;
}

/**
 * Returns true when there is at least one connected social integration, synced
 * profile, engagement event, or campaign interest signal to ground Audience
 * Intelligence in real data.
 */
export function hasAudienceSourceData(counts: AudienceSourceDataCounts): boolean {
  return (
    counts.integrations > 0 ||
    counts.profiles > 0 ||
    counts.events > 0 ||
    counts.signals > 0
  );
}
