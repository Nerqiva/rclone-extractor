import { Database } from "bun:sqlite";
import { DB_PATH, ensureDataDir } from "../config";
import { SQLITE_SCHEMA } from "./schema";
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
    this.db.exec(SQLITE_SCHEMA);
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

  async close(): Promise<void> {
    this.db?.close();
  }
}
