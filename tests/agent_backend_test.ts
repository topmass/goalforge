import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  defaultGlobalConfig,
  describeBackend,
  readGlobalConfig,
  updateGlobalConfig,
} from "../src/board/global_config.ts";
import {
  createAgentClient,
  ensureLocalPiProvider,
  LOCAL_PI_PROVIDER_ID,
} from "../src/workers/agent_backend.ts";
import { CodexAppServerClient } from "../src/workers/codex_app_server.ts";
import { PiRpcClient } from "../src/workers/pi_rpc_client.ts";

function withTempHome(fn: () => void): void {
  const home = Deno.makeTempDirSync();
  const previous = Deno.env.get("GOALFORGE_HOME");
  Deno.env.set("GOALFORGE_HOME", home);
  try {
    fn();
  } finally {
    if (previous === undefined) {
      Deno.env.delete("GOALFORGE_HOME");
    } else {
      Deno.env.set("GOALFORGE_HOME", previous);
    }
    Deno.removeSync(home, { recursive: true });
  }
}

Deno.test("global config defaults to codex and persists backend updates", () => {
  withTempHome(() => {
    assertEquals(readGlobalConfig().backend, "codex");
    const updated = updateGlobalConfig({
      backend: "local",
      local: { endpoint: "http://100.1.2.3:8080/v1", model: "qwen3-coder" },
    });
    assertEquals(updated.backend, "local");
    const reread = readGlobalConfig();
    assertEquals(reread.local.endpoint, "http://100.1.2.3:8080/v1");
    assertEquals(reread.local.model, "qwen3-coder");
    assertEquals(reread.claude.model, defaultGlobalConfig().claude.model);
    assertStringIncludes(describeBackend(reread), "qwen3-coder");

    const next = updateGlobalConfig({ backend: "codex" });
    assertEquals(next.local.endpoint, "http://100.1.2.3:8080/v1");
  });
});

Deno.test("agent client factory selects the configured backend", () => {
  withTempHome(() => {
    const root = Deno.makeTempDirSync();
    try {
      assert(createAgentClient(root, () => {}) instanceof CodexAppServerClient);
      updateGlobalConfig({ backend: "pi" });
      assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
      const modelsPath = `${root}/models.json`;
      Deno.env.set("GOALFORGE_PI_MODELS_PATH", modelsPath);
      try {
        updateGlobalConfig({ backend: "local" });
        assert(createAgentClient(root, () => {}) instanceof PiRpcClient);
        const models = JSON.parse(Deno.readTextFileSync(modelsPath));
        assertEquals(
          models.providers[LOCAL_PI_PROVIDER_ID].baseUrl,
          readGlobalConfig().local.endpoint,
        );
      } finally {
        Deno.env.delete("GOALFORGE_PI_MODELS_PATH");
      }
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  });
});

Deno.test("ensureLocalPiProvider merges idempotently and preserves other providers", () => {
  const dir = Deno.makeTempDirSync();
  const modelsPath = `${dir}/models.json`;
  try {
    Deno.writeTextFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
        },
      }),
    );
    const config = {
      ...defaultGlobalConfig(),
      local: { endpoint: "http://100.1.2.3:8080/v1", model: "qwen3-coder", apiKey: "none" },
    };
    assertEquals(ensureLocalPiProvider(config, modelsPath), true);
    assertEquals(ensureLocalPiProvider(config, modelsPath), false);
    const written = JSON.parse(Deno.readTextFileSync(modelsPath));
    assertEquals(written.providers.ollama.baseUrl, "http://localhost:11434/v1");
    assertEquals(written.providers[LOCAL_PI_PROVIDER_ID].models, [{ id: "qwen3-coder" }]);

    config.local.endpoint = "http://other:9090/v1";
    assertEquals(ensureLocalPiProvider(config, modelsPath), true);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
