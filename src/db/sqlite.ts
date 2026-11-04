import { Database } from "bun:sqlite";
import { DB_PATH } from "../config";
import { SQLITE_SCHEMA } from "./schema";
import type { Store } from "./index";

export class SqliteStore implements Store {
  private db: Database;

  constructor() {
    this.db = new Database(DB_PATH, { create: true });
  }

  backend(): "sqlite" | "postgres" {
    return "sqlite";
  }

  async init(): Promise<void> {
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(SQLITE_SCHEMA);
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.query(sql).run(...(params as never[]));
  }

  async insertReturningId(sql: string, params: unknown[] = []): Promise<number> {
    const res = this.db.query(sql).run(...(params as never[]));
    return Number(res.lastInsertRowid);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.db.query(sql).all(...(params as never[])) as T[];
  }

  async get1<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    return (this.db.query(sql).get(...(params as never[])) as T) ?? null;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
