from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    content = read(path)
    actual = content.count(old)
    if actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old[:140]!r}")
    write(path, content.replace(old, new, count))


def insert_before(path: str, marker: str, addition: str) -> None:
    content = read(path)
    if marker not in content:
        raise RuntimeError(f"{path}: marker not found: {marker!r}")
    write(path, content.replace(marker, addition + marker, 1))


replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''    kind?: string
    mode?: CacheMode
  }) => Effect.Effect<Response, CacheError>''',
    '''    kind?: string
    mode?: CacheMode
    source?: MarketplaceSource
  }) => Effect.Effect<Response, CacheError>''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''      kind?: string
      mode?: CacheMode
    }) {''',
    '''      kind?: string
      mode?: CacheMode
      source?: MarketplaceSource
    }) {''',
)

insert_before(
    "packages/opencode/src/marketplace/cache.ts",
    '''    const put = Effect.fn("MarketplaceCache.put")''',
    '''    const validateLocalArtifact = Effect.fnUntraced(function* (
      source: MarketplaceSource | undefined,
      target: URL,
    ) {
      if (target.protocol !== "file:" || !source) return
      const sourceURL = new URL(source.url)
      if (sourceURL.protocol !== "file:") {
        return yield* new CacheError({
          operation: "validate local artifact",
          message: `Network Marketplace source ${source.name} cannot reference local file ${target.href}`,
        })
      }

      const sourcePath = fileURLToPath(sourceURL)
      const rootPath = sourceURL.pathname.endsWith("/") ? sourcePath : path.dirname(sourcePath)
      const targetPath = fileURLToPath(target)
      const [root, candidate] = yield* Effect.tryPromise({
        try: () => Promise.all([fsNode.realpath(rootPath), fsNode.realpath(targetPath)]),
        catch: (error) => cacheError("validate local artifact", error),
      })
      const relative = path.relative(root, candidate)
      if (relative === "") return
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return yield* new CacheError({
          operation: "validate local artifact",
          message: `Local Marketplace artifact escapes its source directory: ${target.href}`,
        })
      }
    })

''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''      const parsed = new URL(input.url)
      const url = parsed.href''',
    '''      const parsed = new URL(input.url)
      yield* validateLocalArtifact(input.source, parsed)
      const url = parsed.href''',
)

replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''    const fetchArtifact = Effect.fnUntraced(function* (input: { url: string; headers?: HeadersInit; kind: string }) {
      const response = yield* fetchResponse({ ...input, mode: "refresh" })''',
    '''    const fetchArtifact = Effect.fnUntraced(function* (input: {
      url: string
      headers?: HeadersInit
      kind: string
      source: MarketplaceSource
    }) {
      const response = yield* fetchResponse({ ...input, mode: "refresh" })''',
)

# Every subresource fetch carries its catalog source, allowing file targets to
# be rejected for network catalogs and containment-checked for local catalogs.
replace(
    "packages/opencode/src/marketplace/cache.ts",
    'fetchArtifact({ url: indexURL, headers, kind: "skill-index" })',
    'fetchArtifact({ url: indexURL, headers, kind: "skill-index", source: input.source })',
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''            kind: "skill-file",
          })''',
    '''            kind: "skill-file",
            source: input.source,
          })''',
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''        kind: "skill-file",
      })''',
    '''        kind: "skill-file",
        source: input.source,
      })''',
    count=2,
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''          kind: "plugin-file",
        })''',
    '''          kind: "plugin-file",
          source,
        })''',
)
replace(
    "packages/opencode/src/marketplace/cache.ts",
    '''          kind: "instruction",
        })''',
    '''          kind: "instruction",
          source,
        })''',
)

replace(
    "packages/opencode/src/marketplace/service.ts",
    '''            kind: "icon",
            mode: "refresh",''',
    '''            kind: "icon",
            mode: "refresh",
            source: input.listing.source,''',
)

insert_before(
    "packages/opencode/test/marketplace/cache.test.ts",
    '''  it.effect("materializes a remote skill into an immutable local tree", () =>''',
    '''  it.effect("prevents network catalogs and local path escapes from reading file artifacts", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-marketplace-boundary-"))),
      (root) =>
        Effect.gen(function* () {
          const sourceRoot = path.join(root, "source")
          const catalog = path.join(sourceRoot, "marketplace.json")
          const outside = path.join(root, "outside.md")
          yield* Effect.tryPromise(async () => {
            await fs.mkdir(sourceRoot, { recursive: true })
            await fs.writeFile(catalog, "{}")
            await fs.writeFile(outside, "must not be loaded")
          })

          const cache = yield* MarketplaceCache.Service
          const fileURL = pathToFileURL(outside).href
          const escaped = yield* cache
            .materializePlan(
              { instructions: [fileURL] },
              { id: "local", name: "Local", url: pathToFileURL(catalog).href, trust: "private" },
            )
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
          expect(escaped?.message).toContain("escapes its source directory")

          const remote = yield* cache
            .materializePlan(
              { instructions: [fileURL] },
              { id: "remote", name: "Remote", url: "https://example.test/marketplace.json", trust: "community" },
            )
            .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }))
          expect(remote?.message).toContain("cannot reference local file")
        }),
      (root) => Effect.tryPromise(() => fs.rm(root, { recursive: true, force: true })),
    ),
  )

''',
)

replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '''source directory later becomes unavailable. `..` traversal is rejected.''',
    '''source directory later becomes unavailable. `..` traversal is rejected. File artifacts must resolve inside the local
source directory, and network catalogs cannot reference `file://` artifacts.''',
)
replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '''работать, даже если исходный каталог позже недоступен. Переход через `..` запрещён.''',
    '''работать, даже если исходный каталог позже недоступен. Переход через `..` запрещён. Файловые артефакты должны
находиться внутри каталога локального источника, а сетевые каталоги не могут ссылаться на `file://` артефакты.''',
)

print("Local Marketplace source security hardening applied")
