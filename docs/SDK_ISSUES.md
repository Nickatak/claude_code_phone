# SDK Issues

Bugs we've encountered in `@anthropic-ai/claude-agent-sdk` that we work around in this project. Each one is filed as a candidate to report upstream once we have time to write a clean repro.

---

## 1. Wrong native binary variant selected on glibc Linux x64 when both glibc and musl variants are installed

**Status:** Open. Worked around in [managed_query.js](../managed_query.js) via the `pathToClaudeCodeExecutable` option in `query()`.

**Affected SDK version observed:** `@anthropic-ai/claude-agent-sdk` 0.2.109 (sdk.mjs's version comment) with optional native packages at version 0.2.126.

**Symptom**

On a host where `npm install` brought in both `@anthropic-ai/claude-agent-sdk-linux-x64` and `@anthropic-ai/claude-agent-sdk-linux-x64-musl` as optional dependencies, calling `query()` produces:

```
Error: Claude Code native binary not found at .../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable.
```

The error message says "not found" but the binary is present at that path. Running it directly:

```
$ ./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude --version
bash: line 1: ./node_modules/...claude-agent-sdk-linux-x64-musl/claude: cannot execute: required file not found
```

The "cannot execute: required file not found" here is the Linux dynamic linker's well-known message for a glibc-vs-musl ABI mismatch. The musl binary's ELF interpreter (`/lib/ld-musl-x86_64.so.1` or similar) doesn't exist on the glibc system, so `exec(2)` returns ENOENT, which Bash surfaces as "not found." The SDK then surfaces it as if the binary file itself were missing.

The glibc variant exists in the same `node_modules` and runs cleanly:

```
$ ./node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --version
2.1.126 (Claude Code)
```

So the binaries are fine — only the SDK's selection logic is wrong.

**Reproduction**

1. Linux x86_64 system with glibc (e.g., Debian, Ubuntu, Fedora — *not* Alpine)
2. Node version where npm's optional-dep resolution puts both `linux-x64` and `linux-x64-musl` packages on disk. We've seen this happen with Node 20.19; we've seen it *not* happen with Node 21.6 (which only put `linux-x64`).
3. `npm install @anthropic-ai/claude-agent-sdk@0.2.x`
4. `ls node_modules/@anthropic-ai/` should show both `claude-agent-sdk-linux-x64` and `claude-agent-sdk-linux-x64-musl`
5. Any `query()` call fails with the error above

**Why this is an SDK bug, not a separate npm bug**

The presence of both packages is npm's optional-dep behavior and may differ across npm versions. But regardless of which packages are on disk, the SDK should pick the variant that matches the *running* libc, not assume.

The right libc-detection for Linux x64 is roughly: check whether `/lib/x86_64-linux-gnu/libc.so.6` (or `/lib64/libc.so.6`) exists, OR call `getconf GNU_LIBC_VERSION` and parse, OR — simplest — `ldd` itself and parse "musl" or "glibc" from the output. Whichever approach, the SDK should pick the matching variant.

A simpler but still-valid heuristic: try the variant that matches the host's reported libc; if it fails to exec, fall back to the other variant before erroring.

**Workaround in this project**

[managed_query.js](../managed_query.js) checks for the linux-x64 (glibc) binary's presence at startup and explicitly passes `pathToClaudeCodeExecutable` to `query()`:

```js
const claude_glibc_binary = resolve(
  __dirname,
  "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
);
const path_to_claude_code_executable = existsSync(claude_glibc_binary)
  ? claude_glibc_binary
  : undefined;
```

Naive: assumes glibc on linux-x64. Won't auto-handle actual musl deployments. Acceptable for our deployment surface (Debian on dock01); a real SDK fix would obsolete this.

**Suggested upstream fix**

Inside the SDK's variant-resolution logic, add a libc detection step on Linux platforms before choosing between `-linux-x64` and `-linux-x64-musl`. The detection can be cheap: `process.report.getReport().header.glibcVersionRuntime` is non-null on glibc systems and undefined on musl. (If that's unreliable across Node versions, fall back to checking `/usr/bin/ldd --version` output for "musl" or "glibc" / "GNU".)

Failing that, an even simpler change: try-exec the chosen binary at startup; if it fails with ENOENT (the glibc/musl mismatch surface), swap variants before erroring out.
