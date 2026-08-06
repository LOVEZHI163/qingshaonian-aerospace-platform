import { rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptsDirectory, "..");
const distDirectory = resolve(webRoot, "dist");
const relativeDist = relative(webRoot, distDirectory);

if (
  relativeDist !== "dist"
  || isAbsolute(relativeDist)
  || relativeDist === ".."
  || relativeDist.startsWith(`..${sep}`)
) {
  throw new Error(`Refusing to clean an unsafe build path: ${distDirectory}`);
}

await rm(distDirectory, {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 100
});
