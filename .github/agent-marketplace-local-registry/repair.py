from pathlib import Path

allowed = {
    Path("packages/opencode/src/config/config.ts.rej"),
    Path("packages/sdk/js/src/v2/gen/types.gen.ts.rej"),
    Path("packages/tui/src/feature-plugins/system/marketplace.tsx.rej"),
    Path("packages/web/src/content/docs/ru/marketplace.mdx.rej"),
}
actual = set(Path(".").glob("**/*.rej"))
unexpected = actual - allowed
if unexpected:
    raise SystemExit(f"Unexpected rejected hunks: {sorted(map(str, unexpected))}")

config = Path("packages/opencode/src/config/config.ts")
text = config.read_text()
if 'import * as MarketplaceRegistry from "@/marketplace/registry"' not in text:
    anchor = 'import { withTransientReadRetry } from "@/util/effect-http-client"\n'
    addition = (
        'import type { MarketplaceHostConfig } from "@opencode-ai/core/marketplace"\n'
        'import { composeMarketplaceConfig, decomposeMarketplaceConfig } from "@/marketplace/overlay"\n'
        'import * as MarketplaceRegistry from "@/marketplace/registry"\n'
    )
    if anchor not in text:
        raise SystemExit("Config import anchor was not found")
    text = text.replace(anchor, anchor + addition, 1)

if "const loadGlobal = Effect.fnUntraced" not in text:
    anchor = "      return result\n    })\n\n    const [cachedGlobal, invalidateGlobal]"
    replacement = (
        "      delete result.marketplace\n"
        "      return result\n"
        "    })\n\n"
        "    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {\n"
        "      const raw = yield* loadGlobalRaw(env)\n"
        "      const state = yield* marketplace.read()\n"
        "      return composeMarketplaceConfig(raw as MarketplaceHostConfig, state) as Info\n"
        "    })\n\n"
        "    const [cachedGlobal, invalidateGlobal]"
    )
    if anchor not in text:
        raise SystemExit("Config loadGlobal anchor was not found")
    text = text.replace(anchor, replacement, 1)
config.write_text(text)

sdk = Path("packages/sdk/js/src/v2/gen/types.gen.ts")
text = sdk.read_text()
marker = "  marketplace?: {\n"
if marker + "    revision?: number\n" not in text:
    if marker not in text:
        raise SystemExit("SDK marketplace type anchor was not found")
    sdk.write_text(text.replace(marker, marker + "    revision?: number\n", 1))

tui = Path("packages/tui/src/feature-plugins/system/marketplace.tsx")
text = tui.read_text()

old = "    const result = uninstallMarketplaceItem(config(), props.listing.key)\n"
new = (
    "    const cfg = config()\n"
    "    if (!cfg) return\n"
    "    const result = uninstallMarketplaceItem(cfg, props.listing.key)\n"
)
if old in text:
    text = text.replace(old, new, 1)

old = "      onSelect={(option) => {\n        const state = installed()\n"
new = "      onSelect={(option) => {\n        const cfg = config()\n        if (!cfg) return\n        const state = installed()\n"
if old in text:
    text = text.replace(old, new, 1)

for before, after in {
    "marketplaceItemEnabled(config(), props.listing.key)": "marketplaceItemEnabled(cfg, props.listing.key)",
    "setMarketplaceItemEnabled(config(), props.listing.key, enabled)": "setMarketplaceItemEnabled(cfg, props.listing.key, enabled)",
    "marketplaceSkillEnabled(config(), props.listing.key, id)": "marketplaceSkillEnabled(cfg, props.listing.key, id)",
    "setMarketplaceSkillEnabled(config(), props.listing.key, id, enabled)": "setMarketplaceSkillEnabled(cfg, props.listing.key, id, enabled)",
    "marketplaceMcpEnabled(config(), props.listing.key, name)": "marketplaceMcpEnabled(cfg, props.listing.key, name)",
    "setMarketplaceMcpEnabled(config(), props.listing.key, name, enabled)": "setMarketplaceMcpEnabled(cfg, props.listing.key, name, enabled)",
}.items():
    text = text.replace(before, after)

old = (
    "function Sources(props: { api: TuiPluginApi }) {\n"
    "  const config = () => readConfig(props.api)\n"
    "  const rows = createMemo<DialogSelectOption<string>[]>(() =>\n"
    "    marketplaceSources(config()).map((source) => ({\n"
)
new = (
    "function Sources(props: { api: TuiPluginApi }) {\n"
    "  const [config] = createResource(() => readConfig(props.api))\n"
    "  const rows = createMemo<DialogSelectOption<string>[]>(() =>\n"
    "    marketplaceSources(config() ?? {}).map((source) => ({\n"
)
if old in text:
    text = text.replace(old, new, 1)

old = (
    "      const source = createMarketplaceSource({ url: raw })\n"
    "      await save(upsertMarketplaceSource(config(), source), `Added ${source.name}`)\n"
)
new = (
    "      const source = createMarketplaceSource({ url: raw })\n"
    "      const cfg = config()\n"
    "      if (!cfg) return\n"
    "      await save(upsertMarketplaceSource(cfg, source), `Added ${source.name}`)\n"
)
if old in text:
    text = text.replace(old, new, 1)

old = (
    "  async function remove() {\n"
    "    const source = marketplaceSources(config()).find((item) => item.id === current)\n"
)
new = (
    "  async function remove() {\n"
    "    const cfg = config()\n"
    "    if (!cfg) return\n"
    "    const source = marketplaceSources(cfg).find((item) => item.id === current)\n"
)
if old in text:
    text = text.replace(old, new, 1)
text = text.replace(
    "    await save(removeMarketplaceSource(config(), source.id), `Removed ${source.name}`)\n",
    "    await save(removeMarketplaceSource(cfg, source.id), `Removed ${source.name}`)\n",
    1,
)

old = (
    "      onSelect={(option) => {\n"
    "        const source = marketplaceSources(config()).find((item) => item.id === option.value)\n"
)
new = (
    "      onSelect={(option) => {\n"
    "        const cfg = config()\n"
    "        if (!cfg) return\n"
    "        const source = marketplaceSources(cfg).find((item) => item.id === option.value)\n"
)
if old in text:
    text = text.replace(old, new, 1)
text = text.replace(
    "          toggleMarketplaceSource(config(), source.id, source.enabled === false),\n",
    "          toggleMarketplaceSource(cfg, source.id, source.enabled === false),\n",
    1,
)
tui.write_text(text)

for forbidden in (
    "uninstallMarketplaceItem(config(), props.listing.key)",
    "marketplaceItemEnabled(config(), props.listing.key)",
    "setMarketplaceItemEnabled(config(), props.listing.key, enabled)",
    "marketplaceSkillEnabled(config(), props.listing.key, id)",
    "setMarketplaceSkillEnabled(config(), props.listing.key, id, enabled)",
    "marketplaceMcpEnabled(config(), props.listing.key, name)",
    "setMarketplaceMcpEnabled(config(), props.listing.key, name, enabled)",
    "marketplaceSources(config())",
    "upsertMarketplaceSource(config(), source)",
    "removeMarketplaceSource(config(), source.id)",
    "toggleMarketplaceSource(config(), source.id",
    "const config = () => readConfig(props.api)",
):
    if forbidden in text:
        raise SystemExit(f"TUI still contains unresolved async config usage: {forbidden}")
if text.count("const [config] = createResource(() => readConfig(props.api))") < 2:
    raise SystemExit("TUI did not create resources for both component and source views")

docs = Path("packages/web/src/content/docs/ru/marketplace.mdx")
text = docs.read_text()
paragraph = (
    "Источники Marketplace, установленные пакеты и состояния компонентов хранятся в локальном реестре приложения\n"
    "OpenCode, а не в `opencode.json` или `opencode.jsonc`. Активные install plans проецируются в эффективную конфигурацию\n"
    "только в памяти. Поэтому установка, обновление, выключение и удаление пакета не изменяют пользовательский файл\n"
    "конфигурации.\n\n"
    "Команда `opencode plugin marketplace export --name team` экспортирует установленный набор как переносимый профиль.\n"
    "Заголовки запросов источников, installation receipts и другое локальное служебное состояние в экспорт не попадают.\n\n"
)
if "в локальном реестре приложения" not in text:
    anchor = (
        "Установленный пакет может оставаться установленным, когда он выключен. Каждый объявленный скил и MCP-сервер также\n"
        "можно включать или выключать независимо.\n\n"
    )
    if anchor not in text:
        raise SystemExit("Russian documentation anchor was not found")
    docs.write_text(text.replace(anchor, anchor + paragraph, 1))

for reject in actual:
    reject.unlink()

required = {
    config: 'MarketplaceRegistry from "@/marketplace/registry"',
    sdk: "revision?: number",
    tui: "uninstallMarketplaceItem(cfg, props.listing.key)",
    docs: "в локальном реестре приложения",
}
for file, needle in required.items():
    if needle not in file.read_text():
        raise SystemExit(f"Required transformation missing in {file}: {needle}")
