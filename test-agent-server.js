const { createAgentServer, _test } = require("./agent-server");

async function request(baseUrl, pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const data = await response.json();
  return { response, data };
}

function expectStatus(result, status, label) {
  if (result.response.status !== status || typeof result.data.error !== "string") {
    throw new Error(`${label}: ${result.response.status} ${JSON.stringify(result.data)}`);
  }
}

async function main() {
  const server = createAgentServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await request(baseUrl, "/health");
    const data = health.data;
    if (!health.response.ok || data.ok !== true || data.browserConfigSupported !== true || typeof data.serverConfigured !== "boolean" ||
      !data.defaults || !data.defaults.provider || !data.defaults.model || !data.defaults.baseUrl || !Number.isFinite(data.defaults.maxTokens)) {
      throw new Error(`Unexpected health response: ${JSON.stringify(data)}`);
    }

    expectStatus(await request(baseUrl, "/api/stock?code=600519abc"), 400, "invalid stock code");
    expectStatus(await request(baseUrl, "/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid"
    }), 400, "invalid json");
    expectStatus(await request(baseUrl, "/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "unsupported", llmConfig: { apiKey: "test" } })
    }), 400, "unsupported task");
    expectStatus(await request(baseUrl, "/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "config-test",
        llmConfig: { provider: "custom", apiKey: "test", model: "test", baseUrl: "http://127.0.0.1:1234/v1" }
      })
    }), 400, "private llm base url");
    expectStatus(await request(baseUrl, "/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "config-test",
        llmConfig: { provider: "custom", apiKey: "test", model: "test", baseUrl: "file:///tmp/model" }
      })
    }), 400, "invalid llm protocol");
    expectStatus(await request(baseUrl, "/api/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "config-test", padding: "x".repeat(1_000_000) })
    }), 413, "large body");

    const blockedAddresses = ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fc00::1", "fe80::1"];
    if (!blockedAddresses.every(_test.isBlockedIp) || _test.isBlockedIp("8.8.8.8")) {
      throw new Error("Unexpected IP safety classification");
    }
    await _test.validateLlmBaseUrl("https://api.openai.com/v1", "openai");

    console.log(JSON.stringify({ health: data, inputErrors: 6, blockedAddresses: blockedAddresses.length }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
