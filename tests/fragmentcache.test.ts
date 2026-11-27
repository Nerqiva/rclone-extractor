import { test, expect } from "bun:test";
import { cachedFragment } from "../src/fragmentcache";

test("same fingerprint reuses the rendered fragment", async () => {
  let fingerprint = "a";
  let builds = 0;
  const build = async () => {
    builds++;
    return `<div>${builds}</div>`;
  };
  const first = await cachedFragment("same-fp", async () => fingerprint, build);
  const second = await cachedFragment("same-fp", async () => fingerprint, build);
  expect(first).toBe(second);
  expect(builds).toBe(1);

  fingerprint = "b";
  const third = await cachedFragment("same-fp", async () => fingerprint, build);
  expect(third).toBe("<div>2</div>");
  expect(builds).toBe(2);
});

test("different keys do not share a fragment", async () => {
  let builds = 0;
  const build = async () => {
    builds++;
    return `html-${builds}`;
  };
  const a = await cachedFragment("key-a", async () => "x", build);
  const b = await cachedFragment("key-b", async () => "x", build);
  expect(a).not.toBe(b);
  expect(builds).toBe(2);
});

test("the cache is bounded so polls cannot grow it without limit", async () => {
  let builds = 0;
  const build = async () => {
    builds++;
    return `html-${builds}`;
  };
  for (let i = 0; i < 9; i++) {
    await cachedFragment(`bounded-${i}`, async () => `fp-${i}`, build);
  }
  const again = await cachedFragment("bounded-0", async () => "fp-0", build);
  expect(again).toBe("html-10");
  expect(builds).toBe(10);
});
