import type { DatabaseLocation } from "./settings.ts";

let current: DatabaseLocation | undefined;

// The one authority for the process: the entry publishes the location it
// resolved at session start, and the library uses it instead of its own
// fail-closed resolution. Passing undefined clears it.
export function publishLocation(location: DatabaseLocation | undefined): void {
  current = location;
}

export function authoritativeLocation(): DatabaseLocation | undefined {
  return current;
}
