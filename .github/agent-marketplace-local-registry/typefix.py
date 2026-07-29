from pathlib import Path

config = Path("packages/opencode/src/config/config.ts")
text = config.read_text()
old = "        const stored = yield* marketplace.replace(requestedState)\n"
new = "        const stored = yield* marketplace.replace(requestedState).pipe(Effect.orDie)\n"
if old in text:
    text = text.replace(old, new, 1)
if new not in text:
    raise SystemExit("Config did not terminate registry conflicts at the existing no-error boundary")
config.write_text(text)

registry = Path("packages/opencode/src/marketplace/registry.ts")
text = registry.read_text()
old = (
    "function view(file: RegistryFile): MarketplaceState {\n"
    "  return { ...structuredClone(file.state), revision: file.revision }\n"
    "}\n"
)
new = (
    "function view(file: RegistryFile): MarketplaceState {\n"
    "  const state = structuredClone(file.state) as MarketplaceState\n"
    "  return { ...state, revision: file.revision }\n"
    "}\n"
)
if old in text:
    text = text.replace(old, new, 1)
if new not in text:
    raise SystemExit("Registry decoded state was not converted to the mutable domain type")
registry.write_text(text)
