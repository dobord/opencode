export * as MarketplaceGit from "./git.js"

import path from "path"
import { Effect, Stream } from "effect"
import { MarketplaceOperationContext } from "./operation-context.js"
import { ChildProcess } from "effect/process"
import { FSUtil } from "@opencode/util/fs-util"
import { AppProcess } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"

/** Read selected files at an immutable commit without downloading unrelated blobs. */
export const readFiles = Effect.fn("MarketplaceGit.readFiles")(function* (input: {
  remote: string
  commit: string
  files: ReadonlyMap<string, string>
  directory: string
}) {
  const fs = yield* FSUtil.Service
  const proc = yield* AppProcess.Service
  const files = Array.from(input.files.values())
  if (
    !/^[a-f\d]{40}$/i.test(input.commit) ||
    files.some(
      (file) =>
        !file ||
        file.split("/").some((part) => !part || part === "." || part === "..") ||
        file.includes("\\") ||
        file.includes("\n") ||
        path.posix.isAbsolute(file),
    )
  ) {
    return yield* Effect.fail(new Error("Invalid pinned repository file selection"))
  }
  yield* fs.ensureDir(input.directory)
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: input.directory, prefix: "skills-git-" })
  const checkout = path.join(temporary, "repository")
  const operation = yield* MarketplaceOperationContext.Current
  const run = Effect.fnUntraced(function* (args: string[], cwd: string, stdin?: string) {
    const command = ChildProcess.make(gitExecutable(), args, {
      cwd,
      extendEnv: true,
      env: { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_PROGRESS_DELAY: "0" },
      stdin: "pipe",
    })
    if (operation && stdin === undefined) {
      yield* Effect.gen(function* () {
        const handle = yield* proc.spawn(command)
        // runStream splits on newlines before yielding. Git updates in-place
        // with carriage returns, so consume the raw streams here instead.
        yield* Stream.merge(handle.stdout, handle.stderr).pipe(
          Stream.decodeText,
          Stream.map((chunk) => chunk.replace(/\r/g, "\n")),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const progress = receivingObjects(line)
            return progress ? operation.progress(progress) : Effect.void
          }),
        )
        const exitCode = yield* handle.exitCode
        if (exitCode !== 0)
          return yield* new AppProcess.AppProcessError({ command: `${gitExecutable()} ${args.join(" ")}`, exitCode })
      }).pipe(Effect.timeout("2 minutes"))
      return
    }
    const result = yield* proc.run(command, { stdin, timeout: "2 minutes" })
    yield* AppProcess.requireSuccess(result)
  })
  yield* run(
    [
      "clone",
      "--progress",
      "--filter=blob:none",
      "--no-checkout",
      "--depth=1",
      "--single-branch",
      "--",
      input.remote,
      checkout,
    ],
    temporary,
  )
  yield* run(["fetch", "--progress", "--filter=blob:none", "--depth=1", "origin", input.commit], checkout)
  // Exact paths through stdin avoid Windows command-line limits. Checkout
  // fetches selected missing blobs together, not one HTTP request per file.
  yield* run(
    ["sparse-checkout", "set", "--no-cone", "--stdin"],
    checkout,
    files.map((file) => "/" + file.replace(/([*?\[\]\\])/g, "\\$1")).join("\n") + "\n",
  )
  yield* run(["checkout", "--progress", "--detach", input.commit], checkout)
  return new Map(
    yield* Effect.forEach(Array.from(input.files), ([url, file]) =>
      fs.readFile(path.join(checkout, ...file.split("/"))).pipe(Effect.map((bytes) => [url, bytes] as const)),
    ),
  )
}, Effect.scoped)

function receivingObjects(line: string) {
  const match = /Receiving objects:\s+\d+%\s+\((\d+)\/(\d+)\)/.exec(line)
  if (!match) return undefined
  return { completed: Number(match[1]), total: Number(match[2]), unit: "objects" as const }
}
