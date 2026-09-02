import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WZ_AEROSPACE_2026_COPY } from "../src/content/wz-aerospace-2026.js";

const python = process.env.DOCUMENT_PYTHON;
if (!python) {
  throw new Error("DOCUMENT_PYTHON must point to a Python runtime with python-docx");
}

const generator = fileURLToPath(new URL("./generate-rules-document.py", import.meta.url));
const output = fileURLToPath(
  new URL("../public/documents/wz-aerospace-2026-rules.docx", import.meta.url)
);
const result = spawnSync(python, [generator, output], {
  input: JSON.stringify(WZ_AEROSPACE_2026_COPY.rulesDocument),
  encoding: "utf8",
  stdio: ["pipe", "inherit", "inherit"]
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
