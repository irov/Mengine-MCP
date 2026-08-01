import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await Promise.all([
  rm(path.join(repositoryRoot, "dist"), { force: true, recursive: true }),
  rm(path.join(repositoryRoot, "dist-test"), { force: true, recursive: true }),
  rm(path.join(repositoryRoot, "release"), { force: true, recursive: true }),
]);
