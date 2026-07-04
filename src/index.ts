/**
 * pi-hindsight — Self-learning extension for Pi coding agent.
 *
 * Installation:
 *   pi install /path/to/pi-hindsight
 *   # or:  pi install npm:pi-hindsight
 *
 * Learns from past agent sessions and injects relevant lessons
 * into future prompts. Patterns are stored in JSON at:
 *   ~/.pi/agent/extensions/hindsight/patterns.json
 */

import type { ExtensionAPI } from "./pi-api.js";
import { setupHandlers } from "./hindsight.js";

const factory = (pi: ExtensionAPI): void => {
  setupHandlers(pi);
};

export default factory;
