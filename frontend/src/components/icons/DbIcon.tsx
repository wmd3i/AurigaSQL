import type { DataEngine } from "../../api/bff";
import { inferDataEngine, normalizeDataEngine } from "../../lib/databaseEngine";
import { DialectIcon } from "../home/DialectIcon";

export type DbEngine = DataEngine;

export function dbEngine(database: string): DbEngine {
  return inferDataEngine(database);
}

export function DbIcon({ engine, className }: { engine: DbEngine; className?: string }) {
  return <DialectIcon dialect={normalizeDataEngine(engine)} className={className} />;
}
