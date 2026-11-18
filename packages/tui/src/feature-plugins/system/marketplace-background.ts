import type { Plugin } from "@opencode/plugin/tui"
import type { MarketplaceOperation } from "@opencode/schema/marketplace-operation"
import { uuid } from "@opencode/util/uuid"

export async function openMarketplaceBackground(context: Plugin.Context) {
  const client = context.client.experimental.marketplace
  const location = context.location ?? context.data.location.default()
  const submit = async (command: MarketplaceOperation.Command) => {
    const operation = await client.operations.create({ location, request_id: uuid(), command })
    context.ui.toast.show({
      title: "Marketplace",
      message: `Queued ${operation.kind}: ${operation.id}. Open Marketplace operations to follow it.`,
      variant: "info",
    })
  }
  for (;;) {
    const [view, operations] = await Promise.all([client.snapshot({ location }), client.operations.list({ location })])
    const selected = await context.ui.dialog.select({
      title: "Marketplace",
      options: [
        { title: "Operations and prepared plans", value: "operations", category: "Actions" },
        { title: "Refresh catalogs", value: "refresh", category: "Actions" },
        { title: "Add catalog source", value: "source-add", category: "Actions" },
        { title: "Manage catalog sources", value: "sources", category: "Actions" },
        { title: "Update all packages", value: "update-all", category: "Actions" },
        { title: "Prune unused cache", value: "prune", category: "Actions" },
        { title: "Export profile", value: "profile", category: "Actions" },
        ...view.listings.map((listing) => ({
          title: listing.item.name,
          value: `item:${listing.key}`,
          description: listing.item.description,
          footer: listing.status,
          category: listing.item.kind,
        })),
      ],
    })
    if (!selected) return
    if (selected === "profile") {
      await context.ui.dialog.alert({
        title: "Marketplace profile",
        message: JSON.stringify(await client.profileExport({ location }), null, 2),
      })
      continue
    }
    if (selected === "operations") {
      const id = await context.ui.dialog.select({
        title: "Marketplace operations",
        options: operations.toReversed().map((operation) => ({
          title: operation.kind,
          value: operation.id,
          description: operation.target ?? operation.id,
          footer:
            operation.status === "running"
              ? `${operation.phase}${operation.progress ? ` ${operation.progress.completed}/${operation.progress.total ?? "?"} ${operation.progress.unit}` : ""}`
              : operation.status,
        })),
      })
      if (!id) continue
      const operation = await client.operations.get({ location, id })
      if (operation.status === "succeeded" && operation.result.plan?.ok && operation.result.fingerprint) {
        const plan = operation.result.plan
        if (
          await context.ui.dialog.confirm({
            title: "Confirm installation",
            message: [
              plan.summary,
              ...(plan.trust_warning
                ? ["This catalog is unverified. Extensions may execute code on your computer."]
                : []),
              ...plan.conflicts.map((conflict) => `Override: ${conflict.path}`),
              ...plan.permissions,
            ].join("\n"),
          })
        )
          await submit({
            kind: "install",
            key: plan.key,
            expected_fingerprint: operation.result.fingerprint,
            force: plan.conflicts.length > 0,
            accept_untrusted: plan.trust_warning,
          })
        continue
      }
      if (
        operation.status === "queued" ||
        (operation.status === "running" && !["applying", "refreshing-config"].includes(operation.phase))
      ) {
        if (
          await context.ui.dialog.confirm({
            title: "Cancel operation?",
            message: `${operation.kind}: ${operation.target ?? operation.id}`,
          })
        )
          await client.operations.cancel({ location, id })
        continue
      }
      await context.ui.dialog.alert({ title: "Marketplace operation", message: JSON.stringify(operation, null, 2) })
      continue
    }
    if (selected === "refresh") {
      await submit({ kind: "refresh" })
      continue
    }
    if (selected === "prune") {
      await submit({ kind: "prune" })
      continue
    }
    if (selected === "update-all") {
      await submit({ kind: "update-all" })
      continue
    }
    if (selected === "source-add") {
      const url = await context.ui.dialog.prompt({
        title: "Add catalog source",
        placeholder: "Catalog URL or local path",
      })
      if (url) await submit({ kind: "source-add", url, trust: "community" })
      continue
    }
    if (selected === "sources") {
      const id = await context.ui.dialog.select({
        title: "Catalog sources",
        options: (view.state.sources ?? []).map((source) => ({
          title: source.name,
          value: source.id,
          description: source.reference ?? source.url,
          footer: view.source_status?.find((status) => status.id === source.id)?.status ?? "checking",
        })),
      })
      const source = view.state.sources?.find((source) => source.id === id)
      if (!source) continue
      const action = await context.ui.dialog.select({
        title: source.name,
        options: [
          { title: source.enabled === false ? "Enable" : "Disable", value: "toggle" },
          { title: "Remove source", value: "remove" },
        ],
      })
      if (action === "remove") await submit({ kind: "source-remove", id: source.id })
      if (action === "toggle") await submit({ kind: "source-toggle", id: source.id, enabled: source.enabled === false })
      continue
    }
    const listing = view.listings.find((listing) => `item:${listing.key}` === selected)
    if (!listing) continue
    const installed = view.state.installed?.[listing.key]
    const action = await context.ui.dialog.select({
      title: listing.item.name,
      options: [
        { title: installed ? "Prepare update" : "Prepare installation", value: "prepare" },
        ...(installed
          ? [
              { title: "Uninstall", value: "uninstall" },
              { title: installed.enabled === false ? "Enable package" : "Disable package", value: "toggle" },
              ...(listing.item.install.skills?.items ?? []).map((skill) => ({
                title: `${installed.disabled_skills?.includes(skill.id) ? "Enable" : "Disable"} skill: ${skill.name}`,
                value: `skill:${skill.id}`,
              })),
              ...Object.keys(listing.item.install.mcp ?? {}).map((name) => ({
                title: `${installed.disabled_mcp?.includes(name) ? "Enable" : "Disable"} MCP: ${name}`,
                value: `mcp:${name}`,
              })),
            ]
          : []),
      ],
    })
    if (action === "prepare") await submit({ kind: "prepare-install", key: listing.key })
    if (action === "uninstall") await submit({ kind: "uninstall", key: listing.key })
    if (action === "toggle")
      await submit({ kind: "toggle", key: listing.key, component: "package", enabled: installed?.enabled === false })
    if (action?.startsWith("skill:"))
      await submit({
        kind: "toggle",
        key: listing.key,
        component: "skill",
        id: action.slice(6),
        enabled: installed?.disabled_skills?.includes(action.slice(6)) === true,
      })
    if (action?.startsWith("mcp:"))
      await submit({
        kind: "toggle",
        key: listing.key,
        component: "mcp",
        id: action.slice(4),
        enabled: installed?.disabled_mcp?.includes(action.slice(4)) === true,
      })
  }
}
