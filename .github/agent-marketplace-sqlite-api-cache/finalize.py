from pathlib import Path


def must_replace(path: str, old: str, new: str):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


# The generated SDK deliberately uses transport schemas while the TUI uses the
# richer core Marketplace domain types. Keep that cast at the API boundary
# instead of requiring the two generated representations to be assignable.
must_replace(
    "packages/tui/src/feature-plugins/system/marketplace.tsx",
    '''async function applyMutation(
  api: TuiPluginApi,
  request: Promise<{ data?: MarketplaceMutationResult; error?: unknown }>,
  message: string,
) {
  try {
    const result = await unwrap(request)''',
    '''async function applyMutation(
  api: TuiPluginApi,
  request: PromiseLike<{ data?: unknown; error?: unknown }>,
  message: string,
) {
  try {
    const result = await unwrap<MarketplaceMutationResult>(request)''',
)

must_replace(
    "packages/tui/src/feature-plugins/system/marketplace.tsx",
    'const summary = await unwrap(cachePruneRequest(props.api, { max_age_days: 30 }))',
    'const summary = await unwrap<MarketplaceView["cache"]>(cachePruneRequest(props.api, { max_age_days: 30 }))',
)


# Every public Marketplace operation needs an exerciser scenario so coverage,
# authorization, and Effect-runtime modes validate the dedicated API surface.
# The source scenario uses the built-in catalog URL to stay fully offline and
# avoid leaving network sockets alive in the long-running Effect exerciser.
marketplace_scenarios = '''  http.protected.get("/marketplace", "marketplace.get").global().json(200, object, "status"),
  http.protected.post("/marketplace/refresh", "marketplace.refresh").global().json(200, object, "status"),
  http.protected
    .post("/marketplace/plan", "marketplace.plan")
    .global()
    .at(() => ({ path: "/marketplace/plan", body: { key: "missing-httpapi" } }))
    .json(200, object, "status"),
  http.protected
    .post("/marketplace/install", "marketplace.install")
    .global()
    .at(() => ({
      path: "/marketplace/install",
      body: { key: "missing-httpapi", expected_revision: 0 },
    }))
    .json(200, object, "status"),
  http.protected
    .post("/marketplace/update-all", "marketplace.updateAll")
    .global()
    .mutating()
    .at(() => ({ path: "/marketplace/update-all", body: { expected_revision: 0 } }))
    .json(200, object, "status"),
  http.protected
    .delete("/marketplace/install/{key}", "marketplace.uninstall")
    .global()
    .at(() => ({
      path: route("/marketplace/install/{key}", { key: "missing-httpapi" }),
      body: { expected_revision: 0 },
    }))
    .json(200, object, "status"),
  http.protected
    .patch("/marketplace/install/{key}", "marketplace.toggle")
    .global()
    .at(() => ({
      path: route("/marketplace/install/{key}", { key: "missing-httpapi" }),
      body: { expected_revision: 0, component: "package", enabled: false },
    }))
    .json(200, object, "status"),
  http.protected
    .post("/marketplace/source", "marketplace.sourceAdd")
    .global()
    .mutating()
    .at(() => ({
      path: "/marketplace/source",
      body: {
        expected_revision: 0,
        url: "builtin://opencode",
        name: "HTTP API Marketplace",
        trust: "community",
      },
    }))
    .json(200, object, "status"),
  http.protected
    .patch("/marketplace/source/{id}", "marketplace.sourceToggle")
    .global()
    .at(() => ({
      path: route("/marketplace/source/{id}", { id: "missing-httpapi-source" }),
      body: { expected_revision: 0, enabled: false },
    }))
    .json(200, object, "status"),
  http.protected
    .delete("/marketplace/source/{id}", "marketplace.sourceRemove")
    .global()
    .at(() => ({
      path: route("/marketplace/source/{id}", { id: "missing-httpapi-source" }),
      body: { expected_revision: 0 },
    }))
    .json(200, object, "status"),
  http.protected
    .post("/marketplace/profile", "marketplace.profileExport")
    .global()
    .at(() => ({ path: "/marketplace/profile", body: { name: "httpapi" } }))
    .json(200, object, "status"),
  http.protected
    .post("/marketplace/cache/prune", "marketplace.cachePrune")
    .global()
    .mutating()
    .at(() => ({ path: "/marketplace/cache/prune", body: { max_age_days: 0 } }))
    .json(200, object, "status"),
'''

must_replace(
    "packages/opencode/test/server/httpapi-exercise/index.ts",
    '''const scenarios: Scenario[] = [
  http.protected
    .get("/global/health", "global.health")''',
    '''const scenarios: Scenario[] = [
''' + marketplace_scenarios + '''  http.protected
    .get("/global/health", "global.health")''',
)
