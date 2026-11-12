import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry"

import plugin from "../index.js"

type EngineFactory = Parameters<OpenClawPluginApi["registerContextEngine"]>[1]
type ToolRegistration = Parameters<OpenClawPluginApi["registerTool"]>

for (const recallTurns of [0, 10]) {
  test(`plugin entry registers its engine and optional recall tool (${recallTurns})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ouc-plugin-api-"))
    try {
      let engineFactory: EngineFactory | undefined
      const tools: ToolRegistration[] = []
      const api = {
        pluginConfig: { recallTurns },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        registerContextEngine(id, factory) {
          assert.equal(id, plugin.id)
          engineFactory = factory
        },
        registerTool(...args) {
          tools.push(args)
        },
      } satisfies Pick<OpenClawPluginApi,
        "pluginConfig" | "logger" | "registerContextEngine" | "registerTool">
      await plugin.register(api as unknown as OpenClawPluginApi)
      assert.ok(engineFactory)
      const engine = await engineFactory({ workspaceDir: root })
      assert.deepEqual(await engine.bootstrap?.({
        sessionId: "session-1", sessionFile: join(root, "session.jsonl"),
      }), {
        bootstrapped: true,
      })
      const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
      assert.equal(engine.info.version, packageJson.version)
      assert.equal(tools.length, recallTurns > 0 ? 1 : 0)
      if (recallTurns > 0) {
        const [factory, options] = tools[0]!
        assert.equal(options?.name, "universal_recall")
        assert.equal(typeof factory, "function")
        if (typeof factory !== "function") throw new Error("Expected tool factory")
        const tool = await factory({
          config: {}, workspaceDir: root, sessionKey: "agent:home:discord:channel:123",
        })
        assert.ok(tool && !Array.isArray(tool))
        assert.equal(tool.name, "universal_recall")
        const result = await tool.execute("recall-1", {})
        assert.equal(result.content[0]?.type, "text")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("release metadata matches the installed SDK and packaged entrypoints", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"))
  const manifest = JSON.parse(await readFile(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"))
  const sdk = JSON.parse(await readFile(new URL("../../node_modules/openclaw/package.json", import.meta.url), "utf8"))
  assert.equal(lock.version, packageJson.version)
  assert.equal(lock.packages[""].version, packageJson.version)
  assert.equal(packageJson.openclaw.build.openclawVersion, sdk.version)
  assert.equal(packageJson.devDependencies.openclaw, sdk.version)
  assert.equal(packageJson.engines.node, sdk.engines.node)
  assert.equal(packageJson.peerDependencies.openclaw, `>=${sdk.version}`)
  assert.equal(packageJson.openclaw.compat.pluginApi, packageJson.peerDependencies.openclaw)
  assert.equal(packageJson.openclaw.install.minHostVersion, packageJson.peerDependencies.openclaw)
  assert.equal(manifest.id, plugin.id)
  assert.equal(manifest.kind, "context-engine")
  for (const entry of [packageJson.main, packageJson.types, ...packageJson.openclaw.runtimeExtensions]) {
    assert.ok((await readFile(new URL(`../../${entry}`, import.meta.url), "utf8")).length > 0)
  }
})

test("compaction accepts and forwards host identity/runtime context to the public delegate", () => {
  // Isolate the experimental module-mock flag and SDK replacement to this child.
  // No native compaction, Gateway state, or production injection seam is needed.
  const script = `
    import assert from "node:assert/strict"
    import { mock } from "node:test"
    const expected = { ok: true, compacted: false, reason: "test delegate" }
    let received
    mock.module("openclaw/plugin-sdk/core", {
      namedExports: { delegateCompactionToRuntime: async (params) => {
        received = params
        return expected
      } },
    })
    const { UniversalCaptureContextEngine } = await import(${JSON.stringify(new URL("../src/context-engine.js", import.meta.url).href)})
    const { parseConfig } = await import(${JSON.stringify(new URL("../src/config.js", import.meta.url).href)})
    const engine = new UniversalCaptureContextEngine({ config: parseConfig({}) })
    const params = {
      sessionId: "session-1", sessionKey: "agent:home:discord:channel:123",
      sessionTarget: { agentId: "home", sessionId: "session-1" },
      runtimeContext: { workspaceDir: "/fixture/agent-workspace", config: { marker: "active-config" } },
      tokenBudget: 4096, force: true, abortSignal: new AbortController().signal,
    }
    for (const field of ["sessionKey", "sessionTarget", "runtimeContext"]) {
      assert.ok(engine.info.acceptedHostParams.includes(field))
    }
    assert.equal(await engine.compact(params), expected)
    assert.equal(received, params)
  `
  const result = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--input-type=module", "--eval", script,
  ], { encoding: "utf8", timeout: 30_000 })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr)
})
