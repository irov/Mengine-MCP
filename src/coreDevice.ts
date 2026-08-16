import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

import { MengineRuntimeError } from "./errors.js";

export function findCoreDeviceTunnelHost(
  interfaces: ReturnType<typeof networkInterfaces>,
  previousHosts: ReadonlySet<string> = new Set(),
): string | undefined {
  const candidates: string[] = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (!name.startsWith("utun") || addresses === undefined) {
      continue;
    }

    for (const address of addresses) {
      if (address.family === "IPv6" && /^fd/iu.test(address.address)) {
        candidates.push(address.address);
      }
    }
  }

  return candidates.find(address => !previousHosts.has(address)) ?? candidates.at(-1);
}

export async function startCoreDeviceTunnel(deviceId: string): Promise<{
  host: string;
  cleanup: () => Promise<void>;
}> {
  if (!/^[A-Za-z0-9._():-]+$/u.test(deviceId)) {
    throw new MengineRuntimeError("invalid_request", "CoreDevice deviceId contains unsupported characters");
  }

  const previousHosts = new Set<string>();
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv6" && /^fd/iu.test(address.address)) {
        previousHosts.add(address.address);
      }
    }
  }

  const child = spawn("xcrun", [
    "lldb",
    "-b",
    "-o", `device select ${deviceId}`,
    "-o", "script import time; time.sleep(86400)",
  ], { stdio: "pipe" });
  let output = "";
  child.stdout.on("data", value => output += value.toString("utf8"));
  child.stderr.on("data", value => output += value.toString("utf8"));

  try {
    const deadline = Date.now() + 10_000;
    let host: string | undefined;
    do {
      host = findCoreDeviceTunnelHost(networkInterfaces(), previousHosts);
      if (host !== undefined) {
        break;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = output.trim();
        throw new Error(`LLDB CoreDevice tunnel exited before it was ready${detail.length === 0 ? "" : `: ${detail}`}`);
      }

      await delay(50);
    } while (Date.now() < deadline);

    if (host === undefined) {
      throw new Error("LLDB connected to the iOS device but no CoreDevice tunnel address appeared");
    }

    let cleanupPromise: Promise<void> | undefined;
    return {
      host,
      cleanup: async () => {
        if (cleanupPromise === undefined) {
          cleanupPromise = stopChild(child);
        }
        await cleanupPromise;
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
    throw error;
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 2_000);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>(resolve => child.once("exit", () => resolve())),
    delay(timeoutMs),
  ]);
}
