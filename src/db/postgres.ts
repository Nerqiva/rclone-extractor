import { SQL } from "bun";
import {
  PG_SCHEMA,
  splitSchemaStatements,
  isTolerantSchemaStatement,
  CRITICAL_TABLES,
  schemaStmtPreview,
  toPgPlaceholders,
  toPgInsert,
} from "./schema";
import type { Store } from "./index";
import { PG_POOL_MAX } from "../config";

/**
 * Postgres store backed by a single Bun SQL client.
 *
 * The pool is deliberately small and idle connections are recycled: the
 * remote Postgres service (Neon/Supabase/Aiven/Render/…) enforces a hard
 * connection cap and reserves a few slots for superusers, so exhausting it
 * surfaces as `53300 remaining connection slots are reserved for roles with
 * the SUPERUSER attribute`. Never open more than a handful of connections
 * per process.
 */
export class PostgresStore implements Store {
  private sql: SQL;
  private readonly isTx: boolean;

  constructor(url: string, tx?: SQL, isTx = false) {
    this.isTx = isTx;
    this.sql =
      tx ??
      new SQL(url, {
        max: PG_POOL_MAX,
        // Recycle idle connections so a quiet process does not hold slots
        // forever on a capped remote service.
        idleTimeout: 20,
        // Fail fast instead of queueing forever behind a saturated remote.
        connectionTimeout: 10,
        // Bound connection lifetime so stale backends get refreshed.
        maxLifetime: 1800,
      });
  }

  backend(): "sqlite" | "postgres" {
    return "postgres";
  }

  async init(): Promise<void> {
    if (this.isTx) throw new Error("init() is not available inside a transaction");
    // PG_SCHEMA must not contain semicolons inside string literals.
    // Index statements are best-effort: a partially migrated database must
    // not crash the process (42703: column does not exist). Table statements
    // stay strict — a missing table is fatal and reported clearly.
    for (const stmt of splitSchemaStatements(PG_SCHEMA)) {
      try {
        await this.sql.unsafe(stmt);
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
    await this.assertCriticalTables();
  }

  private async assertCriticalTables(): Promise<void> {
    for (const table of CRITICAL_TABLES) {
      try {
        await this.sql.unsafe(`SELECT 1 FROM ${table} LIMIT 1`);
      } catch (e) {
        throw new Error(
          `critical table "${table}" is missing or unreadable: ${String(e)}`,
        );
      }
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

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.isTx) return fn(this);
    return (await this.sql.begin(
      async (tx) => fn(new PostgresStore("", tx as SQL, true)),
    )) as T;
  }

  async close(): Promise<void> {
    if (this.isTx) return; // the transaction owns the connection
    await this.sql.end({ timeout: 5 });
  }
}
