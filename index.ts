import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"

import { parseConfig } from "./src/config.js"
import { UniversalCaptureContextEngine } from "./src/context-engine.js"
import { createUniversalRecallTool } from "./src/recall.js"

export default definePluginEntry({
  id: "openclaw-universal-capture",
  name: "OpenClaw Universal Capture",
  description: "OpenClaw context engine for append-only Markdown conversation capture.",
  configSchema: { parse: parseConfig },

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig)

    if (config.recallTurns > 0) {
      api.registerTool((ctx) => createUniversalRecallTool({ config, context: ctx }), {
        name: "universal_recall",
      })
    }

    api.registerContextEngine(
      "openclaw-universal-capture",
      (ctx) =>
        new UniversalCaptureContextEngine({
          config,
          agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir,
          logger: api.logger,
        }),
    )
  },
})
