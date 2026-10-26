import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, ResolvedConfig } from "vite";
import type { AtlasRelease } from "../src/atlas/release";
import { publishOfflineRelease } from "./offline-release";

function separateDirectories(sourceDir: string, outputDir: string) {
  // Resolve existing ancestors too: a new output path can sit below a symlink into public/.
  const canonical = (directory: string): string => {
    const resolved = path.resolve(directory);
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  };
  const source = canonical(sourceDir), output = canonical(outputDir);
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  if (contains(source, output) || contains(output, source)) {
    throw new Error("Atlas release output must not overlap its source");
  }
}

/** Validate every source chunk before publishing any release manifest. Never edits public/. */
export function publishAtlasRelease(sourceDir: string, outputDir: string): AtlasRelease {
  separateDirectories(sourceDir, outputDir);
  const index = JSON.parse(fs.readFileSync(path.join(sourceDir, "index.json"), "utf8"));
  if (!Number.isInteger(index.chunk) || index.chunk < 1 || !Number.isInteger(index.count) || index.count < 1 ||
      !Array.isArray(index.words) || index.words.length !== index.count) throw new Error("Invalid atlas index");
  delete index.release;
  const chunks: { file: string; integrity: string; bytes: Buffer }[] = [];
  for (let n = 0; n * index.chunk < index.count; n++) {
    const bytes = fs.readFileSync(path.join(sourceDir, "entries", `${n}.json`));
    const entries = JSON.parse(bytes.toString("utf8"));
    const rows = index.words.slice(n * index.chunk, (n + 1) * index.chunk);
    if (!Array.isArray(entries) || entries.length !== rows.length ||
        entries.some((e, k) => !e || e.id !== rows[k][0] || e.w !== rows[k][1])) {
      throw new Error(`Atlas chunk ${n} does not match the index`);
    }
    const hash = createHash("sha256").update(bytes).digest();
    chunks.push({ file: `entries/${n}.${hash.toString("hex")}.json`, integrity: `sha256-${hash.toString("base64")}`, bytes });
  }
  const addresses = chunks.map(({ file, integrity }) => ({ file, integrity }));
  const revision = createHash("sha256").update(JSON.stringify(index)).update(JSON.stringify(addresses)).digest("hex");
  const release: AtlasRelease = { format: 1, revision, chunks: addresses };
  fs.mkdirSync(path.join(outputDir, "entries"), { recursive: true });
  for (const chunk of chunks) {
    const destination = path.join(outputDir, chunk.file);
    // Repeated builds must not truncate a file still referenced by the previous manifest.
    if (fs.existsSync(destination) && fs.readFileSync(destination).equals(chunk.bytes)) continue;
    const temporary = `${destination}.release-tmp`;
    try {
      fs.writeFileSync(temporary, chunk.bytes);
      fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  // The manifest is the commit point: all referenced immutable files already exist.
  const temporary = path.join(outputDir, "index.json.release-tmp");
  fs.writeFileSync(temporary, JSON.stringify({ ...index, release }));
  fs.renameSync(temporary, path.join(outputDir, "index.json"));
  return release;
}

export function atlasReleasePlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "atlas-content-release",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
      // Run before Vite empties outDir, not only when the atlas manifest is written.
      separateDirectories(config.publicDir, path.resolve(config.root, config.build.outDir));
    },
    closeBundle() {
      const outputDir = path.resolve(config.root, config.build.outDir);
      publishAtlasRelease(path.join(config.publicDir, "atlas"), path.join(outputDir, "atlas"));
      publishOfflineRelease(outputDir, fs.readFileSync(path.join(config.publicDir, "sw.js"), "utf8"));
    },
  };
}
