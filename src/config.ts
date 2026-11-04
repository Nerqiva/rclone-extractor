import { mkdirSync } from "node:fs";

export const DATA_DIR = process.env.DATA_DIR ?? "./data";
export const DB_PATH = `${DATA_DIR}/app.db`;
export const LOG_DIR = `${DATA_DIR}/logs`;
export const BIND = process.env.BIND ?? "0.0.0.0";
export const PORT = Number(process.env.PORT ?? 8080);
export const APP_PASSWORD = process.env.APP_PASSWORD ?? ""; // fallback only

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync("public", { recursive: true });
