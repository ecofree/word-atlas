/** Build-time content addresses keep an index bound to the exact entry bytes it describes. */
export interface AtlasRelease {
  format: 1;
  revision: string;
  chunks: { file: string; integrity: string }[];
}

export function validRelease(value: unknown, count: number): value is AtlasRelease {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<AtlasRelease>;
  return (
    r.format === 1 &&
    typeof r.revision === "string" && /^[a-f0-9]{64}$/.test(r.revision) &&
    Array.isArray(r.chunks) && r.chunks.length === count &&
    r.chunks.every((c, n) => !!c && typeof c.file === "string" &&
      new RegExp(`^entries/${n}\\.[a-f0-9]{64}\\.json$`).test(c.file) &&
      typeof c.integrity === "string" && /^sha256-[A-Za-z0-9+/]{43}=$/.test(c.integrity))
  );
}
