import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"

import { parseConfig } from "./src/config.js"
import { UniversalCaptureContextEngine } from "./src/context-engine.js"

export default definePluginEntry({
  id: "openclaw-universal-capture",
  name: "OpenClaw Universal Capture",
  description:
    "Append-only markdown conversation capture context engine compatible with native Codex thread resumes.",
  configSchema: { parse: parseConfig },

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig)

    api.registerContextEngine(
      "openclaw-universal-capture",
      (ctx) =>
        new UniversalCaptureContextEngine({
          config,
          workspaceDir: ctx.workspaceDir,
          logger: api.logger,
        }),
    )
  },
})
