import path from "node:path";
import { MonitorDatabase } from "../monitor/database.mjs";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("Usage: node scripts/migration-smoke.mjs <database-path>");

const database = new MonitorDatabase(path.resolve(databasePath));
try {
  const people = database.listPeople();
  const bindings = database.listAllBindings({ limit: 10_000 });
  const activeTargets = database.activeTargets();
  const schemaVersion = Number(database.db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value || 0);
  const roles = Object.fromEntries([...new Set(bindings.map((item) => item.addressRole))].sort().map((role) => [role, bindings.filter((item) => item.addressRole === role).length]));
  console.log(JSON.stringify({
    databasePath: database.file,
    schemaVersion,
    integrity: database.integrityCheck(),
    people: people.length,
    bindings: bindings.length,
    activeTargets: activeTargets.length,
    roles,
    peopleSummary: people.map((person) => ({ handle: person.handle, bindings: person.bindings.length, candidates: person.addressCandidates.length, monitorState: person.monitorState })),
  }, null, 2));
} finally {
  database.close();
}
