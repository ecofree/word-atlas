import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface OfflineRelease {
  format: 1;
  version: string;
  atlasRevision: string;
  mediaRevision: string;
  files: { path: string; integrity: string }[];
}

const MARKER = "/* __ATLAS_OFFLINE_RELEASE__ */ null";

/** Describe the actual production output, including every emitted font and lazy asset. */
export function publishOfflineRelease(outputDir: string, workerTemplate: string): OfflineRelease {
  if (workerTemplate.split(MARKER).length !== 2) throw new Error("Offline worker must contain exactly one release marker");
  const walk = (directory: string): string[] => fs.readdirSync(path.join(outputDir, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return walk(name);
    if (!entry.isFile()) throw new Error(`Offline assets must be regular files: ${name}`);
    return [name];
  });
  const paths = [...new Set([
    "index.html", "atlas/index.json", "manifest.webmanifest", "favicon.svg", "icon-512.png",
    ...walk("assets"), ...(fs.existsSync(path.join(outputDir, "brand")) ? walk("brand") : []),
  ])].sort();
  const files = paths.map((file) => {
    const target = path.join(outputDir, file);
    if (!fs.lstatSync(target).isFile()) throw new Error(`Offline assets must be regular files: ${file}`);
    return { path: file, integrity: `sha256-${createHash("sha256").update(fs.readFileSync(target)).digest("base64")}` };
  });
  const index = JSON.parse(fs.readFileSync(path.join(outputDir, "atlas/index.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/.test(index.release?.revision ?? "")) throw new Error("Offline shell requires a versioned atlas index");
  // Media stays on demand, but a media-only correction must still invalidate the old runtime cache.
  const mediaHash = createHash("sha256");
  const mediaFiles = ["atlas/img", "atlas/thumb", "atlas/audio", "sfx"].flatMap((directory) =>
    fs.existsSync(path.join(outputDir, directory)) ? walk(directory) : [],
  ).sort();
  for (const file of mediaFiles) mediaHash.update(JSON.stringify(file)).update(createHash("sha256").update(fs.readFileSync(path.join(outputDir, file))).digest());
  const mediaRevision = mediaHash.digest("hex");
  const version = createHash("sha256").update(workerTemplate).update(JSON.stringify(files)).update(mediaRevision).digest("hex");
  const release: OfflineRelease = { format: 1, version, atlasRevision: index.release.revision, mediaRevision, files };
  const write = (file: string, contents: string) => {
    const temporary = path.join(outputDir, `${file}.release-tmp`);
    try {
      fs.writeFileSync(temporary, contents);
      fs.renameSync(temporary, path.join(outputDir, file));
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  write("offline-manifest.json", JSON.stringify(release));
  // Publish the worker last; it can only install the complete, verified shell above.
  write("sw.js", workerTemplate.replace(MARKER, JSON.stringify(release)));
  return release;
}
