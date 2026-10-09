import type { ExtensionAPI } from "../deps/pi-coding-agent.ts";

// The Pi entry: package.json's pi.extensions points here. It starts no
// long-lived resource and registers no command yet; each command task adds
// its own registration to this factory.
export default function extension(_pi: ExtensionAPI): void {}
