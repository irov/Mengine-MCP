import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";

import {
  MncpBinaryAssembler,
  MncpDecoder,
  MncpFrameFlags,
  MncpFrameType,
  MncpProtocolError,
  decodeJsonPayload,
  encodeBinaryFrames,
  encodeJsonFrame,
} from "../src/protocol.js";
import { MengineRuntimeError } from "../src/errors.js";
import { validateHandshakePayload } from "../src/session.js";

test("MNCP decoder accepts fragmented and coalesced frames", () => {
  const first = encodeJsonFrame(MncpFrameType.Request, 7, { method: "ping" });
  const second = encodeJsonFrame(MncpFrameType.Response, 7, { result: "pong" });
  const decoder = new MncpDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 9)), []);
  const frames = decoder.push(Buffer.concat([first.subarray(9), second]));

  assert.equal(frames.length, 2);
  assert.deepEqual(decodeJsonPayload(frames[0]!), { method: "ping" });
  assert.deepEqual(decodeJsonPayload(frames[1]!), { result: "pong" });
});

test("MNCP rejects invalid magic and oversized payload", () => {
  const invalid = encodeJsonFrame(MncpFrameType.Request, 1, {});
  invalid.write("NOPE", 0, 4, "ascii");
  assert.throws(() => new MncpDecoder().push(invalid), MncpProtocolError);

  const oversized = encodeJsonFrame(MncpFrameType.Request, 1, { long: "value" });
  assert.throws(() => new MncpDecoder(1).push(oversized), MncpProtocolError);
});

test("MNCP binary chunks reassemble in arrival order independent fashion", () => {
  const payload = Buffer.from("0123456789abcdef", "utf8");
  const encoded = encodeBinaryFrames(11, payload, 5);
  const decoder = new MncpDecoder();
  const decoded = encoded.flatMap(frame => decoder.push(frame));
  const assembler = new MncpBinaryAssembler();

  let result: Buffer | undefined;
  for (const frame of decoded.reverse()) {
    result = assembler.push(frame) ?? result;
  }

  assert.deepEqual(result, payload);
  assert.equal(decoded[0]!.flags & MncpFrameFlags.Final, MncpFrameFlags.Final);
});

test("MNCP enforces aggregate binary size and decodes cancellation", () => {
  const frames = encodeBinaryFrames(21, Buffer.from("123456", "utf8"), 3)
    .flatMap(frame => new MncpDecoder().push(frame));
  const assembler = new MncpBinaryAssembler(5);
  assert.throws(() => {
    for (const frame of frames) {
      assembler.push(frame);
    }
  }, MncpProtocolError);

  const cancel = encodeJsonFrame(MncpFrameType.Cancel, 21, { reason: "timeout" });
  const decoded = new MncpDecoder().push(cancel);
  assert.equal(decoded[0]?.type, MncpFrameType.Cancel);
  assert.deepEqual(decodeJsonPayload(decoded[0]!), { reason: "timeout" });
});

test("MNCP handshake requires exact session token", () => {
  assert.deepEqual(validateHandshakePayload({ method: "handshake", params: { token: "secret", capabilities: ["scene", 7] } }, "secret"), ["scene"]);
  assert.throws(
    () => validateHandshakePayload({ method: "handshake", params: { token: "wrong" } }, "secret"),
    (error: unknown) => error instanceof MengineRuntimeError && error.code === "authentication_failed",
  );
});
