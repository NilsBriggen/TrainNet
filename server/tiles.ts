// The map's track network: every OSM track (main lines, station tracks, sidings, yards) as vector tiles, built locally
// with ogr2ogr from `scripts/rail.ts --ways` into data/rail.mbtiles. Served straight from the MBTiles (SQLite) file.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

let db: Database | null = null, opened = "";
/** One tile (gzipped MVT) or null. MBTiles counts rows from the south (TMS), the map from the north. Opened read-only on first use. */
export function tileOf(file: string, z: number, x: number, y: number): Uint8Array | null {
  if (opened !== file || !db) {
    db?.close();
    db = existsSync(file) ? new Database(file, { readonly: true }) : null; // looked for again until it's there (uploaded after start)
    opened = file;
  }
  const r = db?.query("SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?").get(z, x, (1 << z) - 1 - y) as { tile_data: Uint8Array } | null;
  return r?.tile_data ?? null;
}
