// Defaults for agent metadata when upstream does not supply them.
// OpenOrchestra uses claude-sdk provider (subscription-based, no API key).
export const DEFAULT_PROVIDER = "claude-sdk";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
