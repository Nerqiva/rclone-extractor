import { SQL } from "bun";
import { PG_SCHEMA, toPgPlaceholders, toPgInsert } from "./schema";
import type { Store } from "./index";

export class PostgresStore implements Store {
  private sql: SQL;

  constructor(url: string) {
    this.sql = new SQL(url);
  }

  backend(): "sqlite" | "postgres" {
    return "postgres";
  }

  async init(): Promise<void> {
    for (const stmt of PG_SCHEMA.split(";")) {
      if (stmt.trim()) await this.sql.unsafe(stmt);
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const q = toPgPlaceholders(toPgInsert(sql));
    await this.sql.unsafe(q, params as never[]);
  }

  async insertReturningId(sql: string, params: unknown[] = []): Promise<number> {
    let q = toPgPlaceholders(toPgInsert(sql)).replace(/;?\s*$/, "");
    if (!/RETURNING/i.test(q)) q += " RETURNING id";
    const rows = (await this.sql.unsafe(q, params as never[])) as { id: number }[];
    return Number(rows[0]?.id ?? 0);
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const q = toPgPlaceholders(sql);
    return (await this.sql.unsafe(q, params as never[])) as T[];
  }

  async get1<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
