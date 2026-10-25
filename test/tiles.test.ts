import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tileOf } from "../server/tiles";

test("a tile by map coordinates from an MBTiles file (rows counted from the south); none for an empty spot or a missing file", () => {
  const file = `/tmp/trainnet-tiles-test-${process.pid}.mbtiles`;
  const d = new Database(file, { create: true });
  d.exec("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)");
  d.query("INSERT INTO tiles VALUES (12, 2141, ?, ?)").run((1 << 12) - 1 - 1446, new Uint8Array([31, 139, 1]));
  d.close();
  expect([...tileOf(file, 12, 2141, 1446)!]).toEqual([31, 139, 1]);
  expect(tileOf(file, 12, 2141, 1447)).toBeNull();
  expect(tileOf("/tmp/no-such-file.mbtiles", 12, 2141, 1446)).toBeNull();
});
