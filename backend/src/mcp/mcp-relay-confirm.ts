/**
 * LLM-facing result returned by an MCP write tool when it is serving a relayed
 * browser prompt and has handed the confirmation off to the web chat as a
 * `pending_action` card. It mirrors the AI Assistant's own `preview_shown`
 * status: the write has NOT happened (the browser commits it via
 * `/ai/actions/confirm` on approval), so the agent must not retry or claim
 * success -- it should ask the user to review and approve the card.
 */
export const RELAY_PREVIEW_SHOWN = {
  status: "preview_shown",
  message:
    "A confirmation card was shown to the user in the Monize web chat. The action has NOT been performed yet -- it is applied only when the user approves the card there. Do not retry or say it is done; tell the user to review and approve the card.",
} as const;
