/**
 * Shared types for the reverse MCP relay.
 *
 * The relay lets a user's own MCP agent (Claude CLI/Desktop on their
 * subscription) drive the in-app AI chat: the browser enqueues a prompt, the
 * agent long-polls `get_next_prompt` to claim it, does the work against the
 * Monize MCP tools, and pushes the answer back with `post_response`. No LLM API
 * key lives on the server in this mode.
 */

/**
 * A lightweight reference to an attachment the user uploaded with a relayed
 * prompt. The bytes themselves are held in the in-memory RelayAttachmentStore;
 * the agent fetches them by reading `uri` as an MCP resource. Carries no base64
 * data, so it stays small when passed through the prompt queue and tool result.
 */
export interface RelayAttachmentRef {
  /** Opaque per-user attachment id; the lookup key within the owning user's bucket. */
  id: string;
  filename: string;
  mediaType: string;
  kind: "image" | "pdf" | "text";
  /** MCP resource URI (`monize-attachment://<id>`) the agent reads to view the file. */
  uri: string;
}

/** A prompt claimed by the agent via `get_next_prompt`. */
export interface RelayClaimedPrompt {
  promptId: string;
  prompt: string;
  /** Prior turns in this conversation, oldest first. Lets the agent keep context. */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /**
   * Attachments the user uploaded with this prompt, if any. Binary files
   * (image/pdf) are fetched by the agent via their `uri` as an MCP resource;
   * text/CSV is additionally inlined into `prompt` so it works without a read.
   */
  attachments?: RelayAttachmentRef[];
}

/** The agent's answer to a claimed prompt. */
export interface RelayResponse {
  text: string;
}

/**
 * An intermediate SSE event pushed to the browser while its prompt is still
 * in-flight (e.g. a `pending_action` write-confirmation card). Mirrors the SSE
 * event shape the native AI chat stream emits, so the frontend chat store
 * handles relay and native events identically.
 */
export type RelayServerEvent = {
  type: string;
  [key: string]: unknown;
};

/**
 * Tunnel status for the chat indicator.
 * - `offline`: no agent has polled recently.
 * - `listening`: an agent is connected and idle (a poll is parked or was very
 *   recent) -- the blinking-green state.
 * - `busy`: the agent is currently handling a prompt.
 */
export type RelayTunnelState = "offline" | "listening" | "busy";

export interface RelayTunnelStatus {
  state: RelayTunnelState;
  /** Prompts waiting to be claimed by an agent. */
  queued: number;
}
