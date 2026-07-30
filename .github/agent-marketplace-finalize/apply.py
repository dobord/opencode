from pathlib import Path
import re


def replace(path: str, old: str, new: str):
    target = Path(path)
    text = target.read_text()
    if old not in text:
        raise SystemExit(f"Anchor not found in {path}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_re(path: str, pattern: str, replacement: str):
    target = Path(path)
    text = target.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.DOTALL)
    if count != 1:
        raise SystemExit(f"Pattern not found or ambiguous in {path}: {pattern[:160]!r} ({count})")
    target.write_text(updated)


# Marketplace state is application state. Keep this integration test on the
# SQLite registry boundary instead of reintroducing the removed config field.
skill_test = "packages/opencode/test/skill/skill.test.ts"
replace(
    skill_test,
    'import { Config } from "../../src/config/config"\n',
    'import { Config } from "../../src/config/config"\nimport * as MarketplaceRegistry from "../../src/marketplace/registry"\n',
)
replace_re(
    skill_test,
    r'''  it\.live\("filters skills disabled by an installed marketplace plugin", \(\) =>[\s\S]*?\n  it\.live\("skips skills with missing frontmatter"''',
    '''  it.live("filters skills disabled by an installed marketplace plugin", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(dir, ".opencode", "skill", "marketplace-enabled", "SKILL.md"),
                `---
name: marketplace-enabled
description: Enabled marketplace skill.
---

# Enabled
`,
              ),
              Bun.write(
                path.join(dir, ".opencode", "skill", "marketplace-disabled", "SKILL.md"),
                `---
name: marketplace-disabled
description: Disabled marketplace skill.
---

# Disabled
`,
              ),
            ]),
          )

          const registry = yield* MarketplaceRegistry.Service
          const config = yield* Config.Service
          const before = yield* registry.read()
          yield* registry.replace({
            ...before,
            installed: {
              ...(before.installed ?? {}),
              "source:catalog:plugin": {
                source: "source",
                catalog: "catalog",
                item: "plugin",
                name: "Plugin",
                kind: "plugin",
                version: "1.0.0",
                fingerprint: "test",
                installed_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                plan: {
                  skills: {
                    items: [
                      { id: "enabled", name: "marketplace-enabled" },
                      { id: "disabled", name: "marketplace-disabled" },
                    ],
                  },
                },
                receipt: {},
                disabled_skills: ["disabled"],
              },
            },
          })
          yield* config.invalidate()

          yield* Effect.gen(function* () {
            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((item) => item.location !== "<built-in>")
            expect(list.map((item) => item.name)).toEqual(["marketplace-enabled"])
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const current = yield* registry.read()
                yield* registry
                  .replace({
                    ...before,
                    revision: current.revision ?? 0,
                  })
                  .pipe(Effect.orDie)
                yield* config.invalidate()
              }),
            ),
          )
        }),
      { git: true },
    ),
  )

  it.live("skips skills with missing frontmatter"''',
)


# Pin every newly documented Marketplace CLI shape. Bun regenerates the exact
# platform-normalized snapshot in the validation workflow.
help_test = "packages/opencode/test/cli/help/help-snapshots.test.ts"
replace(
    help_test,
    '  ["github", "run"],\n  ["db", "path"],\n',
    '  ["github", "run"],\n  ["plugin", "marketplace"],\n  ["plugin", "marketplace", "add"],\n  ["plugin", "marketplace", "export"],\n  ["db", "path"],\n',
)


Path("packages/web/src/content/docs/marketplace.mdx").write_text(r'''---
title: Marketplace
description: Install and manage plugins, skills, agents, commands, MCP servers, and reusable bundles without editing opencode.json.
---

Marketplace distributes related plugins, skills, agents, commands, MCP servers, and instruction files as one managed
package. Open **Settings → Marketplace** in the desktop app, or run **Marketplace** from the TUI command palette.

A package may remain installed while disabled. Named skills and MCP servers can also be enabled or disabled
independently.

> Marketplace operations do not write Marketplace state or generated component entries to `opencode.json` or
> `opencode.jsonc`.

---

## State and runtime model

OpenCode separates three kinds of state:

1. **User configuration** remains in `opencode.json` or `opencode.jsonc`.
2. **Marketplace application state** is stored in the OpenCode SQLite database.
3. **Effective runtime configuration** is assembled in memory from the user configuration and active Marketplace
   install plans.

The SQLite registry stores catalog sources, installed packages, component switches, artifact references, and a
monotonic revision. Active plans are projected into the runtime `plugin`, `skills`, `agent`, `command`, `mcp`, and
`instructions` fields only while OpenCode is running.

When user configuration is saved, OpenCode removes unchanged Marketplace projections before writing the file. A value
that the user changed is retained as user-owned configuration. If multiple active packages provide the same logical
resource, the later provider wins; disabling or uninstalling it exposes the next provider without reconstructing a
chain of config-file edits.

Every registry mutation uses the revision observed by the client. A stale desktop or TUI client receives a revision
conflict instead of silently overwriting newer state.

---

## Use Marketplace

The desktop app provides **Discover**, **Installed**, **Updates**, and **Sources** views. The item details panel shows
publisher and provenance information, requested capabilities, setup notes, conflicts, and component switches.

In the TUI:

- run **Marketplace** from the command palette to browse and manage packages;
- run **Marketplace sources**, or press `Ctrl+S` from Marketplace, to manage catalogs;
- press `Enter` on an installed item to manage its components;
- press `Space` in the package list to enable or disable the complete package;
- press `Ctrl+D` in the component view to uninstall it.

### Add a catalog

Add a source from the **Sources** view or with the CLI:

```bash
opencode plugin marketplace add https://git.example.com/ai/agent-marketplace.git
```

A source may be:

- an HTTPS URL to a Marketplace JSON file;
- a GitHub repository URL;
- `github:owner/repository`;
- an HTTP loopback URL for local development.

For Git repository URLs ending in `.git`, OpenCode looks for `.opencode/marketplace.json` through conventional GitHub,
GitLab, and Gitea raw-file routes. Use `--name` to set a display name and `--trust private` for a private catalog.

Catalogs are labelled `official`, `verified`, `community`, or `private`. Official and verified provenance is reserved
for catalogs distributed by OpenCode; user-added catalogs can be community or private. The label does not sandbox
installed code.

Private source headers are stored only in the local SQLite registry. They are redacted from API responses and exported
profiles, are never written to project configuration, and are forwarded to subresources only when the target has the
same origin as the source.

Installed packages remain manageable when their source is disabled, removed, offline, or no longer publishes the
item. OpenCode uses the local package snapshot and materialized artifacts for the installed view and uninstall flow.

---

## Install and update lifecycle

Installation is split into planning and execution:

1. **Plan** reports trust warnings, requested capabilities, and configuration conflicts.
2. **Materialize** downloads remote skills and instructions, validates their structure, and creates immutable local
   artifacts.
3. **Commit** stores the package and artifact references in one revision-checked registry mutation.
4. **Activate** invalidates the effective configuration and connects newly enabled MCP servers.

Community and private catalogs require explicit trust acceptance. Conflicting plugin, agent, command, or MCP providers
require explicit confirmation before installation.

Updates compare semantic versions when possible and also detect changed item fingerprints. **Update all** does not
perform an implicit semantic-version downgrade. Existing component choices are retained when the updated package still
declares those components.

### Enable and disable components

Disabling a package removes its active plan from runtime while keeping the installation and per-component choices.
Re-enabling it restores all components that were not disabled individually.

An explicitly disabled MCP server remains disabled when the complete package is turned off and on. Enabling its own
switch makes it eligible for automatic connection again.

Uninstall removes the package provider from the registry and recomputes the effective overlay. User-modified values are
preserved; shared resources fall back to the next active provider.

---

## Content-addressed artifact cache

Marketplace stores catalog responses, item manifests, icons, remote skill files, and remote instruction files by their
SHA-256 digest in the OpenCode cache directory. Identical bytes are stored once, even when referenced by multiple
packages or sources.

Remote skill and instruction content is materialized into immutable local trees before activation. Relative paths are
validated so an artifact cannot escape its materialization root.

Refresh requests use `ETag` and `Last-Modified` when a source provides them. If the network request fails, OpenCode can
use the last successfully validated cached response. Installed artifact digests are retained during cache pruning.

The desktop app and TUI expose cache statistics and pruning. The API also provides `POST /marketplace/cache/prune`.

---

## Export a portable profile

Export the current package set to a file:

```bash
opencode plugin marketplace export marketplace-team.json --name team
```

Omit the file to print JSON to stdout:

```bash
opencode plugin marketplace export --name team
```

The `opencode.marketplace.profile/v1` profile contains sources, package coordinates, versions, package state, and skill
and MCP switches. Entries are stably sorted. Source headers, credentials, internal plans, cache paths, artifact
metadata, and installation bookkeeping are excluded.

Profile import is not part of this change; the exported format is the portable contract for a later apply/import flow.

---

## Catalog format

A catalog uses the `opencode.marketplace/v1` schema:

```json title=".opencode/marketplace.json"
{
  "schema": "opencode.marketplace/v1",
  "id": "acme",
  "name": "Acme Marketplace",
  "items": [
    {
      "id": "review-suite",
      "name": "Review Suite",
      "description": "Review changes with reusable workflows and documentation tools.",
      "kind": "plugin",
      "version": "1.0.0",
      "publisher": {
        "name": "Acme"
      },
      "icon": {
        "src-light": "./assets/review-suite-light.png",
        "src-dark": "./assets/review-suite-dark.png"
      },
      "brand_color": "#10A37F",
      "install": {
        "plugins": ["@acme/opencode-review@1.0.0"],
        "skills": {
          "items": [
            {
              "id": "review",
              "name": "review",
              "description": "Review the current changes.",
              "path": "./skills/review"
            },
            {
              "id": "release-notes",
              "name": "release-notes",
              "description": "Prepare release notes.",
              "path": "./skills/release-notes"
            }
          ]
        },
        "mcp": {
          "docs": {
            "type": "remote",
            "url": "https://docs.example.com/mcp"
          }
        }
      }
    }
  ]
}
```

Use stable, colon-free identifiers for the catalog, each item, and each named skill.

### Icons

An item may use a single image:

```json
{
  "icon": "./assets/review-suite.png"
}
```

For theme-specific artwork, use `src-light` and optionally `src-dark`. Icon values may be a `./` path relative to the
catalog file, an absolute HTTP or HTTPS URL, or a base64 PNG, JPEG, WebP, or GIF data URL. Relative paths must remain
inside the catalog directory. `brand_color` accepts a six-digit hex color for the fallback background.

### Individually controlled skills

Declare named skills under `install.skills.items`. Each item requires an `id` and the actual skill `name`, and may point
to a dedicated `path` or `url`. Multiple skills may share a source.

Legacy `install.skills.paths` and `install.skills.urls` arrays remain supported. Each source without metadata appears as
one component derived from its path or URL.

### Other install-plan fields

An install plan may also define:

- `plugins`: package strings or `[package, options]` tuples accepted by the `plugin` configuration field;
- `agents`: named agent and subagent configuration;
- `commands`: named slash commands;
- `mcp`: named local or remote MCP server configuration;
- `instructions`: persistent instruction paths or URLs.

---

## Dedicated Marketplace API

Desktop and TUI clients use the domain API instead of replacing the global configuration object:

```text
GET    /marketplace
POST   /marketplace/refresh
POST   /marketplace/plan
POST   /marketplace/install
POST   /marketplace/update-all
DELETE /marketplace/install/{key}
PATCH  /marketplace/install/{key}
POST   /marketplace/source
PATCH  /marketplace/source/{id}
DELETE /marketplace/source/{id}
POST   /marketplace/profile
POST   /marketplace/cache/prune
```

Registry mutations accept `expected_revision`. Public responses omit source headers, materialized plans, internal
artifact references, and other machine-local state.

---

## Security

Marketplace is a discovery, materialization, and configuration mechanism, not a sandbox.

- Plugins execute code inside OpenCode.
- Local MCP servers execute commands on your machine.
- Remote MCP servers receive requests and may require credentials.
- Skills and instructions influence agent behavior.
- Agents and commands can change model, tool, and permission configuration.

Review the publisher, source, repository, requested capabilities, and planned configuration before installation. Prefer
trusted catalogs for executable plugins and pin package versions when reproducibility matters.

## Pre-release migration policy

Marketplace has not shipped with the intermediate storage formats used during development. OpenCode creates the final
Marketplace tables through the normal database schema migration and intentionally does **not** import experimental
`registry.json` files or Marketplace fields written to configuration by earlier feature-branch commits.
''')


Path("packages/web/src/content/docs/ru/marketplace.mdx").write_text(r'''---
title: Marketplace
description: Установка и управление плагинами, скилами, агентами, командами, MCP-серверами и наборами без правок opencode.json.
---

Marketplace распространяет связанные плагины, скилы, агентов, команды, MCP-серверы и файлы инструкций как один
управляемый пакет. В десктопном приложении откройте **Настройки → Marketplace**, а в TUI запустите **Marketplace** из
палитры команд.

Пакет может оставаться установленным, когда он выключен. Именованные скилы и MCP-серверы также можно включать и
выключать независимо.

> Операции Marketplace не записывают состояние Marketplace или сгенерированные компоненты в `opencode.json` либо
> `opencode.jsonc`.

---

## Модель состояния и runtime

OpenCode разделяет три вида состояния:

1. **Пользовательская конфигурация** остаётся в `opencode.json` или `opencode.jsonc`.
2. **Состояние приложения Marketplace** хранится в SQLite-базе OpenCode.
3. **Эффективная runtime-конфигурация** собирается в памяти из пользовательской конфигурации и активных install plans.

SQLite-реестр хранит источники каталогов, установленные пакеты, переключатели компонентов, ссылки на артефакты и
монотонную ревизию. Активные планы проецируются в runtime-поля `plugin`, `skills`, `agent`, `command`, `mcp` и
`instructions` только во время работы OpenCode.

При сохранении пользовательской конфигурации OpenCode удаляет неизменённые проекции Marketplace перед записью файла.
Значение, изменённое пользователем, сохраняется как пользовательское. Если один логический ресурс предоставляют
несколько активных пакетов, побеждает более поздний provider; его выключение или удаление открывает следующий provider
без обратного проигрывания цепочки правок конфигурации.

Каждая мутация реестра использует ревизию, которую видел клиент. Устаревший десктопный или TUI-клиент получает конфликт
ревизий и не может незаметно перезаписать более новое состояние.

---

## Использование Marketplace

В десктопном приложении доступны представления **Обзор**, **Установлено**, **Обновления** и **Источники**. Панель
сведений показывает издателя и происхождение, запрошенные возможности, инструкции настройки, конфликты и переключатели
компонентов.

В TUI:

- запустите **Marketplace** из палитры команд для просмотра и управления пакетами;
- запустите **Marketplace sources** или нажмите `Ctrl+S` в Marketplace для управления каталогами;
- нажмите `Enter` на установленном элементе, чтобы открыть его компоненты;
- нажмите `Space` в списке пакетов, чтобы включить или выключить пакет целиком;
- нажмите `Ctrl+D` в представлении компонентов, чтобы удалить пакет.

### Добавление каталога

Добавьте источник во вкладке **Источники** или через CLI:

```bash
opencode plugin marketplace add https://git.example.com/ai/agent-marketplace.git
```

Источником может быть:

- HTTPS URL JSON-файла Marketplace;
- URL репозитория GitHub;
- сокращение `github:owner/repository`;
- loopback HTTP URL для локальной разработки.

Для URL Git-репозитория с окончанием `.git` OpenCode ищет `.opencode/marketplace.json` через стандартные маршруты сырых
файлов GitHub, GitLab и Gitea. Параметр `--name` задаёт отображаемое имя, а `--trust private` — приватный каталог.

Каталоги имеют метки `official`, `verified`, `community` или `private`. Статусы official и verified зарезервированы для
каталогов OpenCode; добавленные пользователем каталоги могут быть community или private. Метка не изолирует
устанавливаемый код.

Заголовки приватного источника хранятся только в локальном SQLite-реестре. Они скрываются из ответов API и
экспортируемых профилей, никогда не записываются в конфигурацию проекта и передаются подресурсам только при совпадении
origin с источником.

Установленным пакетом можно управлять, даже если источник выключен, удалён, находится офлайн или больше не публикует
элемент. Для представления установленного пакета и удаления OpenCode использует локальный snapshot и материализованные
артефакты.

---

## Жизненный цикл установки и обновления

Установка разделена на планирование и выполнение:

1. **Планирование** показывает предупреждения о доверии, запрошенные возможности и конфликты конфигурации.
2. **Материализация** загружает удалённые скилы и инструкции, проверяет их структуру и создаёт неизменяемые локальные
   артефакты.
3. **Фиксация** сохраняет пакет и ссылки на артефакты одной мутацией реестра с проверкой ревизии.
4. **Активация** инвалидирует эффективную конфигурацию и подключает новые включённые MCP-серверы.

Для каталогов community и private требуется явное принятие доверия. Конфликтующие providers плагинов, агентов, команд
или MCP требуют явного подтверждения до установки.

При обновлении OpenCode по возможности сравнивает семантические версии и дополнительно проверяет fingerprint элемента.
**Обновить всё** не выполняет неявный downgrade семантической версии. Состояния компонентов сохраняются, если
обновлённый пакет продолжает объявлять эти компоненты.

### Включение и выключение компонентов

Выключение пакета удаляет его активный план из runtime, но сохраняет установку и индивидуальные настройки компонентов.
При повторном включении восстанавливаются все компоненты, которые не были выключены отдельно.

Явно выключенный MCP-сервер остаётся выключенным после выключения и повторного включения пакета целиком. Его собственный
переключатель снова разрешает автоматическое подключение.

Удаление убирает provider пакета из реестра и пересчитывает эффективный overlay. Пользовательские изменения сохраняются,
а общие ресурсы переходят к следующему активному provider.

---

## Content-addressed кэш артефактов

Marketplace сохраняет ответы каталогов, манифесты элементов, иконки, удалённые файлы скилов и инструкции по их SHA-256
digest в каталоге кэша OpenCode. Одинаковые байты хранятся один раз, даже если на них ссылаются несколько пакетов или
источников.

Удалённые скилы и инструкции материализуются в неизменяемые локальные деревья до активации. Относительные пути
проверяются, поэтому артефакт не может выйти за корень материализации.

При refresh используются `ETag` и `Last-Modified`, если источник их предоставляет. При сетевой ошибке OpenCode может
использовать последний успешно проверенный ответ из кэша. Digests установленных артефактов сохраняются при очистке
кэша.

Статистика и очистка кэша доступны в десктопном приложении и TUI. API также предоставляет
`POST /marketplace/cache/prune`.

---

## Экспорт переносимого профиля

Экспортируйте текущий набор пакетов в файл:

```bash
opencode plugin marketplace export marketplace-team.json --name team
```

Без имени файла JSON выводится в stdout:

```bash
opencode plugin marketplace export --name team
```

Профиль `opencode.marketplace.profile/v1` содержит источники, координаты и версии пакетов, состояние пакетов и
переключатели скилов и MCP. Записи стабильно сортируются. Заголовки источников, credentials, внутренние планы, пути
кэша, метаданные артефактов и служебные данные установки исключаются.

Импорт профиля не входит в это изменение; экспортируемый формат является переносимым контрактом для будущего
apply/import flow.

---

## Формат каталога

Каталог использует схему `opencode.marketplace/v1`:

```json title=".opencode/marketplace.json"
{
  "schema": "opencode.marketplace/v1",
  "id": "acme",
  "name": "Acme Marketplace",
  "items": [
    {
      "id": "review-suite",
      "name": "Review Suite",
      "description": "Проверка изменений с помощью готовых сценариев и инструментов документации.",
      "kind": "plugin",
      "version": "1.0.0",
      "publisher": {
        "name": "Acme"
      },
      "icon": {
        "src-light": "./assets/review-suite-light.png",
        "src-dark": "./assets/review-suite-dark.png"
      },
      "brand_color": "#10A37F",
      "install": {
        "plugins": ["@acme/opencode-review@1.0.0"],
        "skills": {
          "items": [
            {
              "id": "review",
              "name": "review",
              "description": "Проверить текущие изменения.",
              "path": "./skills/review"
            },
            {
              "id": "release-notes",
              "name": "release-notes",
              "description": "Подготовить примечания к выпуску.",
              "path": "./skills/release-notes"
            }
          ]
        },
        "mcp": {
          "docs": {
            "type": "remote",
            "url": "https://docs.example.com/mcp"
          }
        }
      }
    }
  ]
}
```

Используйте стабильные идентификаторы без двоеточий для каталога, каждого элемента и каждого именованного скила.

### Иконки

Элемент может использовать одну картинку:

```json
{
  "icon": "./assets/review-suite.png"
}
```

Для разных тем используйте `src-light` и необязательный `src-dark`. Иконкой может быть путь с `./` относительно файла
каталога, абсолютный HTTP или HTTPS URL либо data URL с PNG, JPEG, WebP или GIF в base64. Относительный путь должен
оставаться внутри каталога. `brand_color` задаёт фон заглушки шестизначным HEX-цветом.

### Отдельно управляемые скилы

Объявляйте именованные скилы в `install.skills.items`. Элементу нужны `id` и настоящее имя скила `name`; также можно
указать отдельный `path` или `url`. Несколько скилов могут использовать один источник.

Старые массивы `install.skills.paths` и `install.skills.urls` продолжают поддерживаться. Каждый источник без метаданных
отображается как один компонент с именем, полученным из пути или URL.

### Другие поля плана установки

План установки также может задавать:

- `plugins`: строки пакетов или кортежи `[package, options]`, поддерживаемые полем конфигурации `plugin`;
- `agents`: конфигурацию именованных агентов и субагентов;
- `commands`: именованные slash-команды;
- `mcp`: конфигурацию локальных и удалённых MCP-серверов;
- `instructions`: пути или URL постоянных инструкций.

---

## Отдельный API Marketplace

Десктопное приложение и TUI используют доменный API вместо замены полного объекта глобальной конфигурации:

```text
GET    /marketplace
POST   /marketplace/refresh
POST   /marketplace/plan
POST   /marketplace/install
POST   /marketplace/update-all
DELETE /marketplace/install/{key}
PATCH  /marketplace/install/{key}
POST   /marketplace/source
PATCH  /marketplace/source/{id}
DELETE /marketplace/source/{id}
POST   /marketplace/profile
POST   /marketplace/cache/prune
```

Мутации реестра принимают `expected_revision`. Из публичных ответов удаляются заголовки источников,
материализованные планы, внутренние ссылки на артефакты и другое локальное состояние машины.

---

## Безопасность

Marketplace — это механизм обнаружения, материализации и конфигурации, а не песочница.

- Плагины выполняют код внутри OpenCode.
- Локальные MCP-серверы выполняют команды на вашем компьютере.
- Удалённые MCP-серверы получают запросы и могут требовать учётные данные.
- Скилы и инструкции влияют на поведение агента.
- Агенты и команды могут изменять конфигурацию модели, инструментов и разрешений.

Перед установкой проверьте издателя, источник, репозиторий, запрошенные возможности и планируемую конфигурацию. Для
исполняемых плагинов предпочитайте доверенные каталоги и фиксируйте версии пакетов, когда важна воспроизводимость.

## Политика миграции до релиза

Marketplace не выпускался с промежуточными форматами хранения, которые использовались во время разработки. OpenCode
создаёт итоговые таблицы Marketplace обычной миграцией схемы базы данных и намеренно **не** импортирует
экспериментальные `registry.json` или Marketplace-поля конфигурации из предыдущих коммитов feature-ветки.
''')
