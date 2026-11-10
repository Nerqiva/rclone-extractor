import { Database } from "bun:sqlite";
import { DB_PATH, ensureDataDir } from "../config";
import {
  SQLITE_SCHEMA,
  splitSchemaStatements,
  isTolerantSchemaStatement,
  CRITICAL_TABLES,
  schemaStmtPreview,
} from "./schema";
import type { Store } from "./index";

export class SqliteStore implements Store {
  private db: Database | null = null;

  backend(): "sqlite" | "postgres" {
    return "sqlite";
  }

  async init(): Promise<void> {
    if (!ensureDataDir()) {
      throw new Error(
        `SQLite backend requires a writable data directory, but could not create ${DB_PATH}. ` +
          `Set DATA_DIR to a writable path, or configure DATABASE_URL to use Postgres.`,
      );
    }
    this.db = new Database(DB_PATH, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    // Wait instead of erroring immediately when another statement holds the
    // write lock (e.g. the engine logging while an HTTP handler writes).
    this.db.exec("PRAGMA busy_timeout=5000;");
    // Index statements are best-effort; table statements stay strict.
    for (const stmt of splitSchemaStatements(SQLITE_SCHEMA)) {
      try {
        this.db.exec(`${stmt};`);
      } catch (e) {
        if (isTolerantSchemaStatement(stmt)) {
          console.warn(
            `schema: skipping index statement "${schemaStmtPreview(stmt)}": ${String(e)}`,
          );
          continue;
        }
        throw e;
      }
    }
    for (const table of CRITICAL_TABLES) {
      try {
        this.db.query(`SELECT 1 FROM ${table} LIMIT 1`).get();
      } catch (e) {
        throw new Error(
          `critical table "${table}" is missing or unreadable: ${String(e)}`,
        );
      }
    }
  }

  private get handle(): Database {
    if (!this.db) throw new Error("SqliteStore.init() was not called");
    return this.db;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.handle.query(sql).run(...(params as never[]));
  }

  async insertReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const res = this.handle.query(sql).run(...(params as never[]));
    return Number(res.lastInsertRowid);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.handle.query(sql).all(...(params as never[])) as T[];
  }

  async get1<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    return (this.handle.query(sql).get(...(params as never[])) as T) ?? null;
  }

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    const db = this.handle;
    db.exec("BEGIN");
    try {
      const result = await fn(this);
      db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back or connection is broken
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    this.db?.close();
  }
}
