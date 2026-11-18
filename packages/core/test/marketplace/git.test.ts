import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { $ } from "bun"
import { expect } from "bun:test"
import { Effect } from "effect"
import { AppProcess } from "@opencode/util/process"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { MarketplaceGit } from "../../src/marketplace/git.js"
import { testEffect } from "../lib/effect"
import { initGit } from "../fixture/git"
import { tmpdirScoped } from "../fixture/tmpdir"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, AppProcess.node])))

it.live("reads a large skill tree at the pinned commit, including companion files, and removes its checkout", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const source = path.join(temp.path, "source")
    const cache = path.join(temp.path, "cache")
    const selected = [359, 65].flatMap((count, index) =>
      Array.from({ length: count }, (_, file) => `skills/skill-${index}/file-${file}.md`),
    )
    const commit = yield* Effect.promise(async () => {
      await initGit(source)
      await fs.mkdir(path.join(source, "skills/skill-0"), { recursive: true })
      await fs.mkdir(path.join(source, "skills/skill-1"), { recursive: true })
      await Promise.all(selected.map((file) => fs.writeFile(path.join(source, file), file)))
      await fs.writeFile(path.join(source, "unrelated.txt"), "not selected")
      await $`git add .`.cwd(source).quiet()
      await $`git commit -m first`.cwd(source).quiet()
      const commit = (await $`git rev-parse HEAD`.cwd(source).text()).trim()
      await fs.writeFile(path.join(source, selected[0]), "changed after pinned commit")
      await $`git commit -am second`.cwd(source).quiet()
      return commit
    })
    const result = yield* MarketplaceGit.readFiles({
      remote: pathToFileURL(source).href,
      commit,
      directory: cache,
      files: new Map(selected.map((file) => [file, file])),
    })
    expect(result.size).toBe(424)
    expect(new TextDecoder().decode(result.get(selected[0]))).toBe(selected[0])
    expect(result.has("unrelated.txt")).toBe(false)
    expect(yield* Effect.promise(() => fs.readdir(cache))).toEqual([])
  }),
)

it.live("rejects paths outside the pinned checkout before invoking Git", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const result = yield* MarketplaceGit.readFiles({
      remote: "file:///nonexistent",
      commit: "a".repeat(40),
      directory: temp.path,
      files: new Map([["outside", "../outside"]]),
    }).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") throw new Error("Expected path validation to fail")
    expect(result.failure.message).toBe("Invalid pinned repository file selection")
  }),
)
