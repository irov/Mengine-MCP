import net from "node:net";

import {
  MncpDecoder,
  MncpFrameType,
  decodeJsonPayload,
  encodeJsonFrame,
} from "../../dist-test/src/protocol.js";

const [host, portSource, token] = process.argv.slice(2);
const socket = net.createConnection(Number(portSource), host);
const decoder = new MncpDecoder();
const exitTimer = setTimeout(() => socket.destroy(), 8_000);

socket.once("connect", () => {
  socket.write(encodeJsonFrame(MncpFrameType.Request, 1, {
    method: "handshake",
    params: { token, capabilities: [] },
  }));
});

socket.on("data", data => {
  for (const frame of decoder.push(data)) {
    if (frame.type !== MncpFrameType.Request) {
      continue;
    }

    const request = decodeJsonPayload(frame);
    if (request?.method !== "app_stop") {
      continue;
    }

    socket.write(encodeJsonFrame(MncpFrameType.Response, frame.requestId, { result: { stopping: true } }));
    setTimeout(() => socket.end(), 20);
  }
});

socket.once("close", () => {
  clearTimeout(exitTimer);
});
