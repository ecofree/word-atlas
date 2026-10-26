#!/usr/bin/env node
// Import tests explicitly for individual case reports and portable file discovery
// without relying on a shell's recursive glob expansion.
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
async function tests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await tests(target));
    else if (entry.name.endsWith(".test.ts")) files.push(target);
  }
  return files;
}
const files = (await tests(root)).sort();
if (!files.length) throw new Error("No regression tests found");
for (const file of files) await import(pathToFileURL(file));
