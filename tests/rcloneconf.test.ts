import { test, expect } from "bun:test";
import { decodeRcloneConf, normalizeRcloneConf } from "../src/rcloneconf";

const CONF = "[remote]\ntype = local\n";

test("accepts base64-encoded rclone.conf", () => {
  const encoded = Buffer.from(CONF, "utf8").toString("base64");
  const result = normalizeRcloneConf(encoded);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe(CONF);
  expect(result.base64).toBe(encoded);
});

test("accepts base64 with whitespace", () => {
  const encoded = Buffer.from(CONF, "utf8").toString("base64");
  const wrapped = `${encoded.slice(0, 8)}\n${encoded.slice(8)}`;
  expect(decodeRcloneConf(wrapped)).toBe(CONF);
});

test("accepts legacy plain INI", () => {
  const result = normalizeRcloneConf(CONF);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toBe(CONF.trimEnd());
  expect(result.base64).toBe(Buffer.from(CONF.trimEnd(), "utf8").toString("base64"));
});

test("rejects values that are not a config", () => {
  const result = normalizeRcloneConf("not a config");
  expect(result.ok).toBe(false);
  expect(decodeRcloneConf("not a config")).toBe("");
});

test("empty input is allowed", () => {
  expect(normalizeRcloneConf("   ")).toEqual({ ok: true, text: "", base64: "" });
});
