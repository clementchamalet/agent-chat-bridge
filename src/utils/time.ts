/** Compact relative age using one unit. */
export function formatRelativeAge(epochMs: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - epochMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
