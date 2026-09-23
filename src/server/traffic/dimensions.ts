/**
 * Dimension keys for rolled-up rows.
 *
 * Every aggregate family (traffic, optimization, DNS stats) stores a non-null
 * `dimKey` alongside its nullable dimension columns, because a unique index over
 * nullable columns cannot de-duplicate rows in PostgreSQL (NULLs never compare
 * equal). These helpers are the single place that identity is defined, so the writer
 * and any reader always agree.
 */

export interface TrafficDimensions {
  nodeId?: string | null;
  deviceId?: string | null;
  userId?: string | null;
  configId?: string | null;
  domainId?: string | null;
  category?: string | null;
}

/** Sorts component parts so `a|b` and `b|a` produce the same key. */
function joinParts(parts: Array<string | null | undefined>): string {
  const present = parts.filter((part): part is string => Boolean(part));
  if (present.length === 0) return "system";
  return present.sort((joinA, joinB) => (joinA < joinB ? -1 : joinA > joinB ? 1 : 0)).join("|");
}

export function trafficDimKey(dimensions: TrafficDimensions): string {
  return joinParts([
    dimensions.nodeId ? `node:${dimensions.nodeId}` : null,
    dimensions.deviceId ? `device:${dimensions.deviceId}` : null,
    dimensions.userId ? `user:${dimensions.userId}` : null,
    dimensions.configId ? `config:${dimensions.configId}` : null,
    dimensions.domainId ? `domain:${dimensions.domainId}` : null,
    dimensions.category ? `category:${dimensions.category}` : null,
  ]);
}

export interface OptimizationDimensions {
  deviceId?: string | null;
  nodeId?: string | null;
  userId?: string | null;
  profileId?: string | null;
  category?: string | null;
}

export function optimizationDimKey(dimensions: OptimizationDimensions): string {
  return joinParts([
    dimensions.deviceId ? `device:${dimensions.deviceId}` : null,
    dimensions.nodeId ? `node:${dimensions.nodeId}` : null,
    dimensions.userId ? `user:${dimensions.userId}` : null,
    dimensions.profileId ? `profile:${dimensions.profileId}` : null,
    dimensions.category ? `category:${dimensions.category}` : null,
  ]);
}

export function dnsDimKey(dimensions: {
  deviceId?: string | null;
  nodeId?: string | null;
  domainName: string;
}): string {
  return joinParts([
    dimensions.deviceId ? `device:${dimensions.deviceId}` : null,
    dimensions.nodeId ? `node:${dimensions.nodeId}` : null,
    `domain:${dimensions.domainName}`,
  ]);
}

/**
 * The dimension a query should filter on.
 *
 * Rows carry a synthetic `dimKey`, so "system total" queries must select
 * `dimKey = 'system'` rather than "all rows with NULL dimensions"; otherwise a
 * request for the system total would also pick up rows that simply lack one
 * dimension and double-count them.
 */
export const SYSTEM_DIM_KEY = "system";
