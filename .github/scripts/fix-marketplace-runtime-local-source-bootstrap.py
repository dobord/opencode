from pathlib import Path

path = Path(".github/scripts/apply-marketplace-runtime-local-source.py")
text = path.read_text()

replacements = {
    'expect(await first.text()).toBe(\'{"version":1}\')': 'expect(yield* Effect.promise(() => first.text())).toBe(\'{"version":1}\')',
    'expect(await cached.text()).toBe(\'{"version":1}\')': 'expect(yield* Effect.promise(() => cached.text())).toBe(\'{"version":1}\')',
    'expect(await refreshed.text()).toBe(\'{"version":2}\')': 'expect(yield* Effect.promise(() => refreshed.text())).toBe(\'{"version":2}\')',
}
for old, new in replacements.items():
    if old not in text:
        raise RuntimeError(f"missing bootstrap fragment: {old}")
    text = text.replace(old, new, 1)

english = '''replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
)'''
english_fixed = '''replace(
    "packages/web/src/content/docs/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
    count=2,
)'''
russian = '''replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
)'''
russian_fixed = '''replace(
    "packages/web/src/content/docs/ru/marketplace.mdx",
    '"path": "./skills/review"',
    '"url": "./skills/review/"',
    count=2,
)'''
for old, new in [(english, english_fixed), (russian, russian_fixed)]:
    if old not in text:
        raise RuntimeError("missing documentation replacement block")
    text = text.replace(old, new, 1)

marker = 'print("Marketplace runtime activation and local-source changes applied")\n'
if marker not in text:
    raise RuntimeError("main bootstrap end marker is missing")

hardening = r"""
# Local directory candidates are ordered by contract. Do not race the
# .opencode and root catalog paths because both can legitimately exist.
replace(
    "packages/core/src/marketplace.ts",
    '''  const urls = marketplaceCatalogURLs(source.url)
  if (urls.length === 1) return load(urls[0]!)
  return Promise.any(urls.map(load))''',
    '''  const urls = marketplaceCatalogURLs(source.url)
  if (urls.length === 1) return load(urls[0]!)
  if (new URL(urls[0]!).protocol === "file:") {
    let lastError: unknown
    for (const url of urls) {
      try {
        return await load(url)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
  return Promise.any(urls.map(load))''',
)

# Reject percent-encoded traversal as well as literal ../ segments. The first
# string matches the one-backslash text emitted by the original bootstrap;
# the replacement writes a valid two-backslash JavaScript string literal.
replace(
    "packages/core/src/marketplace.ts",
    '''  const pathname = value.split(/[?#]/)[0] ?? value
  if (value.includes("\\") || pathname.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the catalog directory`)
  }
  const relative = directory && !pathname.endsWith("/") ? `${pathname}/${value.slice(pathname.length)}` : value''',
    '''  const pathname = value.split(/[?#]/)[0] ?? value
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new Error(`${label} contains invalid URL encoding`)
  }
  if (value.includes("\\\\") || decoded.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the catalog directory`)
  }
  const relative = directory && !pathname.endsWith("/") ? `${pathname}/${value.slice(pathname.length)}` : value''',
)

insert_before(
    "packages/core/test/marketplace.test.ts",
    '  test("discovers a catalog from a Git repository URL", async () => {',
    '''  test("rejects encoded traversal in catalog-relative local assets", async () => {
    const source = createMarketplaceSource({ url: "file:///tmp/team-marketplace/marketplace.json" })
    const result = await loadMarketplace({
      config: upsertMarketplaceSource({}, source),
      fetch: async () =>
        Response.json({
          schema: "opencode.marketplace/v1",
          id: "unsafe-local",
          name: "Unsafe local",
          items: [
            {
              id: "unsafe",
              name: "Unsafe",
              description: "Encoded traversal",
              kind: "plugin",
              version: "1.0.0",
              install: { plugins: ["./%2e%2e/escape.ts"] },
            },
          ],
        }),
    })

    expect(result.listings).toEqual([])
    expect(result.errors[0]?.message).toContain("stay inside the catalog directory")
  })

''',
)

"""
text = text.replace(marker, hardening + marker, 1)
path.write_text(text)
