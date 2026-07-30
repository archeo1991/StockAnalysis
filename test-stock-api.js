const { createAgentServer } = require("./agent-server");

async function main() {
  const server = createAgentServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/stock?code=600519&style=%E7%9F%AD%E7%BA%BF%E8%A7%82%E5%AF%9F`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!data.stock || data.stock.code !== "600519" || !data.stock.name || !data.stock.close) {
      throw new Error(`Unexpected stock response: ${JSON.stringify(data)}`);
    }

    console.log(JSON.stringify({ code: data.stock.code, name: data.stock.name, close: data.stock.close, ma20: data.stock.ma20 }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
