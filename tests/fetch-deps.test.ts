import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runFetchDeps(installBody: string) {
  const root = mkdtempSync(join(tmpdir(), "rx-fetchdeps-"));
  const stubDir = join(root, "stub");
  const binDir = join(root, "data", "bin");
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(stubDir, "curl"),
    `#!/bin/sh
out=
prev=
for arg in "$@"; do
  case "$prev" in -o) out=$arg ;; esac
  prev=$arg
done
case "$*" in
  *install-rclonex.sh*) cp "$FAKE_INSTALL" "$out"; exit 0 ;;
esac
exit 1
`,
  );
  chmodSync(join(stubDir, "curl"), 0o755);

  const fakeInstall = join(root, "install.sh");
  writeFileSync(
    fakeInstall,
    `#!/bin/sh
if [ -z "\${RCLONEX_INSTALL_DIR:-}" ]; then
  echo 'RCLONEX_INSTALL_DIR is not set' >&2
  exit 1
fi
${installBody}
`,
  );

  const result = Bun.spawnSync({
    cmd: ["sh", join(import.meta.dir, "..", "bin", "fetch-deps.sh")],
    cwd: join(import.meta.dir, ".."),
    env: {
      ...(process.env as Record<string, string>),
      DATA_DIR: join(root, "data"),
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      FAKE_INSTALL: fakeInstall,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { result, binDir, stdout: new TextDecoder().decode(result.stdout) };
}

const installSidecars = `
printf '%s' "\$RCLONEX_INSTALL_DIR" > "\$RCLONEX_INSTALL_DIR/env-check"
printf 'binary' > "\$RCLONEX_INSTALL_DIR/rclonex"
printf 'lib' > "\$RCLONEX_INSTALL_DIR/libc7zip.so"
printf 'engine' > "\$RCLONEX_INSTALL_DIR/7z.so"
mkdir -p "\$RCLONEX_INSTALL_DIR/Codecs"
printf 'rar' > "\$RCLONEX_INSTALL_DIR/Codecs/Rar.so"
`;

test("rclonex refresh uses its install script with the data bin directory", () => {
  const { result, binDir, stdout } = runFetchDeps(installSidecars);
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("rclonex: updated");
  expect(readFileSync(join(binDir, "env-check"), "utf8")).toBe(binDir);
});

test("the install script places 7-Zip sidecars beside the binary", () => {
  const { binDir } = runFetchDeps(installSidecars);
  for (const name of ["rclonex", "libc7zip.so", "7z.so", "Codecs/Rar.so"]) {
    expect(existsSync(join(binDir, name))).toBe(true);
  }
});

test("an up-to-date install is left alone", () => {
  const { result, binDir, stdout } = runFetchDeps("exit 3");
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("rclonex: up to date");
  expect(existsSync(join(binDir, "rclonex"))).toBe(false);
});
