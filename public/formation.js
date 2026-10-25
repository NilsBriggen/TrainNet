// Why a train has no coach formation to show, by the server's formationStatus: the map's panel and the stats pages.
export const FORMATION_WHY = {
  none: () => "Not published for this train (or not yet: asked again in a few hours).",
  past: () => "Only available for today's trains; this run started yesterday.",
  unsupported: () => "This operator doesn't publish coach formations.",
  window: () => "Looked up from an hour before departure until two hours after arrival.",
  busy: (x) => `Lookups are busy right now (shared request quota). Retrying in ${Math.max(5, x.retryAfter ?? 20)} s…`,
  budget: () => "Today's formation lookups are used up (daily request quota). They reset at midnight.",
  error: () => "The formation service didn't answer. Trying again in a couple of minutes.",
  offline: () => "Couldn't reach the server. Trying again in a minute.",
};
