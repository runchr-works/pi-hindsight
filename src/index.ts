/**
 * pi-hindsight — Self-learning extension for Pi coding agent.
 *
 * Hermes-level self-learning:
 * - Markdown memory store (~/.pi/agent/extensions/hindsight/MEMORY.md)
 * - Agent-initiated learning via learn_pattern/recall tools
 * - Automatic reflection after each session
 * - Relevant context injection before each task
 *
 * Installation:
 *   pi install /path/to/pi-hindsight
 *
 * File: ~/.pi/agent/extensions/hindsight/MEMORY.md
 */

import type { ExtensionAPI } from "./pi-api.js";
import { setupHandlers } from "./hindsight.js";

const factory = (pi: ExtensionAPI): void => {
  setupHandlers(pi);
};

export default factory;
