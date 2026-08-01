import { Buffer } from "node:buffer";

export const MNCP_MAGIC = "MNCP";
export const MNCP_VERSION = 1;
export const MNCP_HEADER_SIZE = 24;
export const MNCP_DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;
export const MNCP_BINARY_CHUNK_SIZE = 1024 * 1024;
export const MNCP_MAX_ATTACHMENT_SIZE = 256 * 1024 * 1024;

export enum MncpFrameType {
  Request = 1,
  Response = 2,
  Event = 3,
  Binary = 4,
  Cancel = 5,
}

export enum MncpFrameFlags {
  None = 0,
  Json = 1 << 0,
  Final = 1 << 1,
}

export type MncpFrame = {
  version: number;
  type: MncpFrameType;
  flags: number;
  requestId: number;
  chunkIndex: number;
  chunkCount: number;
  payload: Buffer;
};

export class MncpProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MncpProtocolError";
  }
}

export function encodeFrame(frame: Omit<MncpFrame, "version"> & { version?: number }): Buffer {
  const version = frame.version ?? MNCP_VERSION;

  if (!Number.isInteger(frame.requestId) || frame.requestId < 0 || frame.requestId > 0xffffffff) {
    throw new MncpProtocolError("requestId must be an unsigned 32-bit integer");
  }

  if (frame.payload.length > 0xffffffff) {
    throw new MncpProtocolError("payload is too large for an MNCP frame");
  }

  if (frame.chunkCount < 1 || frame.chunkIndex < 0 || frame.chunkIndex >= frame.chunkCount) {
    throw new MncpProtocolError("invalid binary chunk coordinates");
  }

  const encoded = Buffer.allocUnsafe(MNCP_HEADER_SIZE + frame.payload.length);
  encoded.write(MNCP_MAGIC, 0, 4, "ascii");
  encoded.writeUInt16LE(version, 4);
  encoded.writeUInt8(frame.type, 6);
  encoded.writeUInt8(frame.flags, 7);
  encoded.writeUInt32LE(frame.requestId, 8);
  encoded.writeUInt32LE(frame.payload.length, 12);
  encoded.writeUInt32LE(frame.chunkIndex, 16);
  encoded.writeUInt32LE(frame.chunkCount, 20);
  frame.payload.copy(encoded, MNCP_HEADER_SIZE);

  return encoded;
}

export function encodeJsonFrame(type: MncpFrameType, requestId: number, value: unknown): Buffer {
  return encodeFrame({
    type,
    flags: MncpFrameFlags.Json | MncpFrameFlags.Final,
    requestId,
    chunkIndex: 0,
    chunkCount: 1,
    payload: Buffer.from(JSON.stringify(value), "utf8"),
  });
}

export function encodeBinaryFrames(requestId: number, payload: Buffer, chunkSize = MNCP_BINARY_CHUNK_SIZE): Buffer[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new MncpProtocolError("chunkSize must be a positive integer");
  }

  const chunkCount = Math.max(1, Math.ceil(payload.length / chunkSize));
  const frames: Buffer[] = [];

  for (let chunkIndex = 0; chunkIndex !== chunkCount; ++chunkIndex) {
    const begin = chunkIndex * chunkSize;
    const end = Math.min(begin + chunkSize, payload.length);
    const flags = chunkIndex + 1 === chunkCount ? MncpFrameFlags.Final : MncpFrameFlags.None;

    frames.push(encodeFrame({
      type: MncpFrameType.Binary,
      flags,
      requestId,
      chunkIndex,
      chunkCount,
      payload: payload.subarray(begin, end),
    }));
  }

  return frames;
}

export function decodeJsonPayload(frame: MncpFrame): unknown {
  if ((frame.flags & MncpFrameFlags.Json) === 0) {
    throw new MncpProtocolError("frame does not contain JSON");
  }

  try {
    return JSON.parse(frame.payload.toString("utf8"));
  } catch (error) {
    throw new MncpProtocolError(`invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class MncpDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  public constructor(private readonly maxPayload = MNCP_DEFAULT_MAX_PAYLOAD) {}

  public push(data: Buffer): MncpFrame[] {
    if (data.length === 0) {
      return [];
    }

    this.buffered = this.buffered.length === 0 ? data : Buffer.concat([this.buffered, data]);
    const frames: MncpFrame[] = [];

    while (this.buffered.length >= MNCP_HEADER_SIZE) {
      if (this.buffered.toString("ascii", 0, 4) !== MNCP_MAGIC) {
        throw new MncpProtocolError("invalid MNCP magic");
      }

      const version = this.buffered.readUInt16LE(4);
      if (version !== MNCP_VERSION) {
        throw new MncpProtocolError(`unsupported MNCP version ${version}`);
      }

      const type = this.buffered.readUInt8(6) as MncpFrameType;
      if (type < MncpFrameType.Request || type > MncpFrameType.Cancel) {
        throw new MncpProtocolError(`invalid MNCP frame type ${type}`);
      }

      const flags = this.buffered.readUInt8(7);
      const requestId = this.buffered.readUInt32LE(8);
      const payloadSize = this.buffered.readUInt32LE(12);
      const chunkIndex = this.buffered.readUInt32LE(16);
      const chunkCount = this.buffered.readUInt32LE(20);

      if (payloadSize > this.maxPayload) {
        throw new MncpProtocolError(`MNCP payload ${payloadSize} exceeds limit ${this.maxPayload}`);
      }

      if (chunkCount < 1 || chunkIndex >= chunkCount) {
        throw new MncpProtocolError("invalid MNCP chunk coordinates");
      }

      const frameSize = MNCP_HEADER_SIZE + payloadSize;
      if (this.buffered.length < frameSize) {
        break;
      }

      frames.push({
        version,
        type,
        flags,
        requestId,
        chunkIndex,
        chunkCount,
        payload: Buffer.from(this.buffered.subarray(MNCP_HEADER_SIZE, frameSize)),
      });

      this.buffered = this.buffered.subarray(frameSize);
    }

    return frames;
  }

  public reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}

export class MncpBinaryAssembler {
  private readonly chunks = new Map<number, Buffer>();
  private expectedChunks: number | undefined;
  private totalSize = 0;

  public constructor(private readonly maxSize = MNCP_MAX_ATTACHMENT_SIZE) {}

  public push(frame: MncpFrame): Buffer | undefined {
    if (frame.type !== MncpFrameType.Binary) {
      throw new MncpProtocolError("binary assembler received a non-binary frame");
    }

    if (this.expectedChunks === undefined) {
      this.expectedChunks = frame.chunkCount;
    } else if (this.expectedChunks !== frame.chunkCount) {
      throw new MncpProtocolError("binary chunk count changed mid-stream");
    }

    if (this.chunks.has(frame.chunkIndex)) {
      throw new MncpProtocolError(`duplicate binary chunk ${frame.chunkIndex}`);
    }

    if (this.totalSize + frame.payload.length > this.maxSize) {
      throw new MncpProtocolError(`binary attachment exceeds limit ${this.maxSize}`);
    }

    this.chunks.set(frame.chunkIndex, frame.payload);
    this.totalSize += frame.payload.length;

    if (this.chunks.size !== this.expectedChunks) {
      return undefined;
    }

    const ordered: Buffer[] = [];
    for (let index = 0; index !== this.expectedChunks; ++index) {
      const chunk = this.chunks.get(index);
      if (chunk === undefined) {
        return undefined;
      }
      ordered.push(chunk);
    }

    return Buffer.concat(ordered);
  }
}
