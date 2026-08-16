import net from "node:net";

const host = process.env.MENGINE_MCP_UI_HOST;
const port = Number(process.env.MENGINE_MCP_UI_PORT);
const token = process.env.MENGINE_MCP_UI_TOKEN;
const socket = net.createConnection({ host, port }, () => {
  socket.write(`${JSON.stringify({ type: "hello", token })}\n`);
});

let input = "";
socket.setEncoding("utf8");
socket.on("data", value => {
  input += value;
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline === -1) break;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line.length === 0) continue;
    const request = JSON.parse(line);
    let result = request.params;
    if (request.command === "snapshot") result = { source: "<App><Button name=\"Consent\"/></App>" };
    if (request.command === "screenshot") result = { png: Buffer.from("png").toString("base64") };
    if (request.command === "alert") result = request.params.action === "buttons" ? { buttons: ["Allow"] } : request.params;
    socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    if (request.command === "stop") {
      socket.end();
      process.exitCode = 0;
    }
  }
});
