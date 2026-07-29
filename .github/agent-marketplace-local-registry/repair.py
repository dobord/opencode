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
    config.write_text(text.replace(anchor, anchor + addition, 1))

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
    tui.write_text(text.replace(old, new, 1))
if "uninstallMarketplaceItem(config(), props.listing.key)" in tui.read_text():
    raise SystemExit("TUI uninstall still uses an unresolved async config")

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
