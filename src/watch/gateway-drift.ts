/**
 * Gateway drift advisory helpers — used by the watch command.
 * Corrective auto-revert is intentionally not implemented in v1.
 */
export type DriftEvent = {
  type: string;
  guildId: string;
  detail: string;
  at: string;
};

export function formatDriftAdvisory(event: DriftEvent): string {
  return `[drift advisory] ${event.type}: ${event.detail} (guild ${event.guildId}) @ ${event.at}`;
}
