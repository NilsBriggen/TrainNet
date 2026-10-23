// Consistent copy of stats.db on stdout, for the server's nightly restic backup:
//   docker exec trainnet bun scripts/snapshot.ts > trainnet.db
// Runs inside the container as the app user, so it never leaves root-owned -wal/-shm files behind.
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

const tmp = `/tmp/stats-snapshot-${process.pid}.db`;
new Database(`${process.env.DATA_DIR ?? "data"}/stats.db`, { readonly: true }).exec(`VACUUM INTO '${tmp}'`);
await Bun.write(Bun.stdout, Bun.file(tmp));
rmSync(tmp);
