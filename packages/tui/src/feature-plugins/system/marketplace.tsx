import { Plugin } from "@opencode/plugin/tui"
import { errorMessage } from "../../util/error"

async function open(context: Plugin.Context) {
  const client = context.client.experimental.marketplace
  const location = context.location ?? context.data.location.default()
  try {
    for (;;) {
      const view = await client.get({ location })
      const expected_revision = view.state.revision ?? 0
      const selected = await context.ui.dialog.select({
        title: "Marketplace",
        options: [
          { title: "Refresh catalogs", value: "refresh", category: "Actions" },
          { title: "Add catalog source", value: "source-add", category: "Actions" },
          { title: "Manage catalog sources", value: "sources", category: "Actions" },
          { title: "Update all packages", value: "update-all", category: "Actions" },
          { title: "Export profile", value: "profile", category: "Actions" },
          { title: "Prune unused cache", value: "prune", category: "Actions" },
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
      if (selected === "refresh") {
        const refreshed = await client.refresh({ location })
        if (refreshed.errors.length)
          await context.ui.dialog.alert({
            title: "Catalog errors",
            message: refreshed.errors.map((error) => `${error.source.name}: ${error.message}`).join("\n"),
          })
        continue
      }
      if (selected === "profile") {
        await context.ui.dialog.alert({
          title: "Marketplace profile",
          message: JSON.stringify(await client.profileExport({ location }), null, 2),
        })
        continue
      }
      if (selected === "prune") {
        await client.cachePrune({ location })
        continue
      }
      const result = await (async () => {
        if (selected === "source-add") {
          const url = await context.ui.dialog.prompt({
            title: "Add catalog source",
            placeholder: "Catalog URL or local path",
          })
          if (!url) return
          return client.sourceAdd({ location, expected_revision, url, trust: "community" })
        }
        if (selected === "sources") {
          const id = await context.ui.dialog.select({
            title: "Catalog sources",
            options: (view.state.sources ?? []).map((source) => ({
              title: source.name,
              description: source.url,
              value: source.id,
              footer: source.enabled === false ? "disabled" : "enabled",
            })),
          })
          const source = view.state.sources?.find((source) => source.id === id)
          if (!source) return
          const action = await context.ui.dialog.select({
            title: source.name,
            options: [
              { title: source.enabled === false ? "Enable" : "Disable", value: "toggle" },
              { title: "Remove source", value: "remove" },
            ],
          })
          if (action === "remove") return client.sourceRemove({ location, expected_revision, id: source.id })
          if (action === "toggle")
            return client.sourceToggle({
              location,
              expected_revision,
              id: source.id,
              enabled: source.enabled === false,
            })
          return
        }
        if (selected === "update-all") return client.updateAll({ location, expected_revision })
        const listing = view.listings.find((listing) => `item:${listing.key}` === selected)
        if (!listing) return
        const installed = view.state.installed?.[listing.key]
        const actions = [
          { title: installed ? "Update" : "Install", value: "install" },
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
        ]
        const action = await context.ui.dialog.select({ title: listing.item.name, options: actions })
        if (!action) return
        if (action === "uninstall") return client.uninstall({ location, expected_revision, key: listing.key })
        if (action === "toggle")
          return client.toggle({
            location,
            expected_revision,
            key: listing.key,
            component: "package",
            enabled: installed?.enabled === false,
          })
        if (action.startsWith("skill:")) {
          const id = action.slice(6)
          return client.toggle({
            location,
            expected_revision,
            key: listing.key,
            component: "skill",
            id,
            enabled: installed?.disabled_skills?.includes(id) === true,
          })
        }
        if (action.startsWith("mcp:")) {
          const id = action.slice(4)
          return client.toggle({
            location,
            expected_revision,
            key: listing.key,
            component: "mcp",
            id,
            enabled: installed?.disabled_mcp?.includes(id) === true,
          })
        }
        const plan = await client.plan({ location, key: listing.key })
        if (!plan.ok) throw new Error(plan.message)
        const confirmed = await context.ui.dialog.confirm({
          title: `Install ${listing.item.name}`,
          message: [
            plan.summary,
            ...(plan.trust_warning
              ? ["This catalog is not verified. Extensions can execute code on your computer."]
              : []),
            ...plan.conflicts.map((conflict) => `Override: ${conflict.path}`),
            ...plan.permissions,
          ].join("\n"),
        })
        if (confirmed)
          return client.install({
            location,
            expected_revision,
            key: listing.key,
            force: plan.conflicts.length > 0,
            accept_untrusted: plan.trust_warning,
          })
      })()
      if (result && !result.ok) await context.ui.dialog.alert({ title: "Marketplace", message: result.message })
    }
  } catch (error) {
    await context.ui.dialog.alert({ title: "Marketplace", message: errorMessage(error) })
  }
}

function Commands(props: { context: Plugin.Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "marketplace.open",
        title: "Marketplace",
        group: "System",
        slash: { name: "marketplace" },
        palette: true,
        run: () => open(props.context),
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode.marketplace",
  setup(context) {
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})
