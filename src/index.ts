import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAutoApprove } from "./extension.js";
import { createJevClassifier } from "./classifier.js";

export default function autoApprove(pi: ExtensionAPI): void {
  registerAutoApprove(pi, createJevClassifier());
}
