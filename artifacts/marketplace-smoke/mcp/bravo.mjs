function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "marketplace-bravo", version: "1.0.0" },
      },
    })
    return
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Returns the Bravo Marketplace smoke result.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
    return
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "marketplace-bravo: ready" }] } })
  }
}

process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\n")) {
    if (line.trim()) handle(JSON.parse(line))
  }
})
