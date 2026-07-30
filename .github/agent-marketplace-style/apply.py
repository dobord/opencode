from pathlib import Path


def replace(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing replacement anchor: {label}")
    return text.replace(old, new, 1)


path = Path("packages/app/src/components/marketplace-dialog.tsx")
text = path.read_text()

text = replace(
    text,
    'import { Dialog } from "@opencode-ai/ui/dialog"\nimport { Switch } from "@opencode-ai/ui/switch"',
    'import { Dialog } from "@opencode-ai/ui/dialog"\nimport { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"\nimport { SelectV2 } from "@opencode-ai/ui/v2/select-v2"\nimport { Switch } from "@opencode-ai/ui/v2/switch-v2"\nimport { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"',
    "v2 control imports",
)
text = replace(
    text,
    'import { createStore } from "solid-js/store"\n',
    'import { createStore } from "solid-js/store"\nimport "./marketplace-dialog.css"\n',
    "component stylesheet import",
)
text = replace(
    text,
    '<div class="relative flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">',
    '<div data-component="marketplace-panel" class="relative flex h-full min-h-0 flex-col overflow-hidden">',
    "panel root",
)
text = replace(
    text,
    '<div class="flex flex-wrap items-start justify-between gap-3">',
    '<div data-slot="marketplace-header" class="flex flex-wrap items-start justify-between gap-3">',
    "panel header",
)
text = replace(
    text,
    '<h2 class="text-16-medium text-text-strong">Marketplace</h2>',
    '<h2 data-slot="marketplace-title" class="text-16-medium text-text-strong">Marketplace</h2>',
    "panel title",
)
text = replace(
    text,
    '<p class="mt-1 text-12-regular text-text-weak">\n            SQLite registry · content-addressed cache · revision {revision()}\n          </p>',
    '<p data-slot="marketplace-subtitle" class="mt-1 text-12-regular text-text-weak">\n            SQLite registry · content-addressed cache · revision {revision()}\n          </p>',
    "panel subtitle",
)
text = replace(
    text,
    '<div class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">',
    '<div data-slot="marketplace-toolbar" class="flex flex-wrap items-center gap-2 text-12-regular text-text-weak">',
    "toolbar",
)
text = replace(
    text,
    '''            <button
              type="button"
              disabled={store.busy}
              class="rounded-md bg-surface-raised-base px-2 py-1 text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
              onClick={() => void updateAll()}
            >
              Update all ({updates().length})
            </button>''',
    '''            <ButtonV2 type="button" size="small" variant="neutral" disabled={store.busy} onClick={() => void updateAll()}>
              Update all ({updates().length})
            </ButtonV2>''',
    "update all button",
)
text = replace(
    text,
    '''          <button
            type="button"
            disabled={store.busy}
            class="rounded-md border border-border-base px-2 py-1 text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
            onClick={() => void prune()}
          >
            Prune cache
          </button>
          <button
            type="button"
            disabled={store.busy}
            class="rounded-md border border-border-base px-2 py-1 text-text-base hover:bg-surface-raised-base-hover disabled:opacity-50"
            onClick={() => void refresh()}
          >
            Refresh
          </button>''',
    '''          <ButtonV2 type="button" size="small" variant="outline" disabled={store.busy} onClick={() => void prune()}>
            Prune cache
          </ButtonV2>
          <ButtonV2 type="button" size="small" variant="outline" disabled={store.busy} onClick={() => void refresh()}>
            Refresh
          </ButtonV2>''',
    "toolbar outline buttons",
)
text = replace(
    text,
    '''      <div class="flex flex-wrap items-center gap-1 border-b border-border-weak pb-2">
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              class="rounded-md px-2.5 py-1.5 text-12-medium capitalize"
              classList={{
                "bg-surface-raised-base text-text-strong": store.tab === tab,
                "text-text-weak hover:text-text-base": store.tab !== tab,
              }}
              onClick={() => setStore("tab", tab)}
            >
              {tab}
              <Show when={tab === "updates" && updates().length}> ({updates().length})</Show>
            </button>
          )}
        </For>
      </div>''',
    '''      <div data-slot="marketplace-tabs" class="flex flex-wrap items-center gap-1 border-b pb-2">
        <For each={TABS}>
          {(tab) => (
            <ButtonV2
              type="button"
              size="small"
              variant={store.tab === tab ? "neutral" : "ghost-muted"}
              class="capitalize"
              aria-current={store.tab === tab ? "page" : undefined}
              onClick={() => setStore("tab", tab)}
            >
              {tab}
              <Show when={tab === "updates" && updates().length}> ({updates().length})</Show>
            </ButtonV2>
          )}
        </For>
      </div>''',
    "tab controls",
)
text = replace(
    text,
    '<div class="flex min-h-0 flex-1 gap-3 overflow-hidden">',
    '<div data-slot="marketplace-content" class="flex min-h-0 flex-1 gap-3 overflow-hidden">',
    "main content",
)
text = replace(
    text,
    '<div class="flex min-h-0 w-[42%] min-w-72 flex-col overflow-hidden rounded-lg border border-border-weak bg-surface-base">',
    '<div data-slot="marketplace-pane" class="flex min-h-0 w-[42%] min-w-72 flex-col overflow-hidden rounded-lg">',
    "list pane",
)
text = replace(
    text,
    '''              <div class="flex gap-2 border-b border-border-weak p-2">
                <input
                  autofocus
                  value={store.query}
                  onInput={(event) => setStore("query", event.currentTarget.value)}
                  placeholder="Search marketplace"
                  class="min-w-0 flex-1 rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong outline-none focus:border-border-strong"
                />
                <select
                  value={store.kind}
                  onChange={(event) => setStore("kind", event.currentTarget.value as KindFilter)}
                  class="rounded-md border border-border-base bg-background-base px-2 text-12-regular text-text-base"
                >
                  <For each={KINDS}>{(kind) => <option value={kind}>{kind}</option>}</For>
                </select>
              </div>''',
    '''              <div data-slot="marketplace-filters" class="flex gap-2 border-b p-2">
                <TextInputV2
                  autofocus
                  type="search"
                  appearance="base"
                  value={store.query}
                  onInput={(event) => setStore("query", event.currentTarget.value)}
                  placeholder="Search marketplace"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  aria-label="Search marketplace"
                />
                <SelectV2
                  options={[...KINDS]}
                  current={store.kind}
                  appearance="base"
                  aria-label="Marketplace item type"
                  onSelect={(value) => value && setStore("kind", value)}
                />
              </div>''',
    "catalog filters",
)
text = replace(
    text,
    '''                        <button
                          type="button"
                          class="mb-1 flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-surface-raised-base-hover"
                          classList={{ "bg-surface-raised-base": current()?.key === listing.key }}
                          onClick={() => setStore("selected", listing.key)}
                        >''',
    '''                        <button
                          type="button"
                          data-slot="marketplace-list-item"
                          data-selected={current()?.key === listing.key ? "" : undefined}
                          class="mb-1 flex w-full gap-2.5 rounded-md px-2.5 py-2 text-left"
                          onClick={() => setStore("selected", listing.key)}
                        >''',
    "catalog list item",
)
text = replace(
    text,
    '<div class="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-border-weak bg-surface-base p-4">',
    '<div data-slot="marketplace-pane" class="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg p-4">',
    "details pane",
)
text = replace(
    text,
    '<div class="absolute inset-0 z-10 flex items-center justify-center bg-background-base/80 p-4">',
    '<div data-slot="marketplace-modal-backdrop" class="absolute inset-0 z-10 flex items-center justify-center p-4">',
    "modal backdrop",
)
text = replace(
    text,
    '<div class="w-full max-w-lg rounded-xl border border-border-base bg-surface-base p-4 shadow-lg">',
    '<div data-slot="marketplace-modal" class="w-full max-w-lg rounded-xl p-4">',
    "modal surface",
)
text = replace(
    text,
    '''                <button
                  type="button"
                  class="rounded-md px-3 py-1.5 text-12-medium text-text-base hover:bg-surface-raised-base-hover"
                  onClick={() => setStore("pending", undefined)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={store.busy}
                  class="rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
                  onClick={() => void confirm()}
                >
                  Confirm
                </button>''',
    '''                <ButtonV2 type="button" variant="ghost-muted" onClick={() => setStore("pending", undefined)}>
                  Cancel
                </ButtonV2>
                <ButtonV2
                  type="button"
                  variant={pending().action === "uninstall" ? "danger" : "neutral"}
                  disabled={store.busy}
                  onClick={() => void confirm()}
                >
                  Confirm
                </ButtonV2>''',
    "confirmation buttons",
)
text = replace(
    text,
    '<span class="shrink-0 rounded bg-surface-raised-base px-1.5 py-0.5 text-10-medium uppercase">{props.value}</span>',
    '<span data-slot="marketplace-status" class="shrink-0 rounded px-1.5 py-0.5 text-10-medium uppercase">{props.value}</span>',
    "status badge",
)
text = replace(
    text,
    '''        <button
          type="button"
          disabled={props.busy}
          class="shrink-0 rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong hover:bg-surface-raised-base-hover disabled:opacity-50"
          onClick={props.action}
        >
          {status() === "available" ? "Install" : status() === "update" ? "Update" : "Uninstall"}
        </button>''',
    '''        <ButtonV2
          type="button"
          variant={status() === "installed" ? "danger" : "neutral"}
          disabled={props.busy}
          class="shrink-0"
          onClick={props.action}
        >
          {status() === "available" ? "Install" : status() === "update" ? "Update" : "Uninstall"}
        </ButtonV2>''',
    "details action button",
)
text = replace(
    text,
    '<div class="mt-5 rounded-lg border border-border-weak">',
    '<div data-slot="marketplace-component-list" class="mt-5 rounded-lg">',
    "component list",
)
text = replace(
    text,
    '<div class="min-h-0 flex-1 overflow-y-auto">\n      <div class="grid gap-2 rounded-lg border border-border-weak bg-surface-base p-3 md:grid-cols-[1fr_13rem_9rem_auto]">',
    '<div data-slot="marketplace-content" class="min-h-0 flex-1 overflow-y-auto">\n      <div data-slot="marketplace-source-form" class="grid gap-2 rounded-lg p-3 md:grid-cols-[1fr_13rem_9rem_auto]">',
    "sources content and form",
)
text = replace(
    text,
    '''        <input
          value={props.sourceURL}
          onInput={(event) => props.setURL(event.currentTarget.value)}
          placeholder="https://… or github:owner/repository"
          class="rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong"
        />
        <input
          value={props.sourceName}
          onInput={(event) => props.setName(event.currentTarget.value)}
          placeholder="Display name"
          class="rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong"
        />
        <select
          value={props.sourceTrust}
          onChange={(event) => props.setTrust(event.currentTarget.value as MarketplaceConfiguredTrust)}
          class="rounded-md border border-border-base bg-background-base px-2.5 py-1.5 text-13-regular text-text-strong"
        >
          <option value="community">community</option>
          <option value="private">private</option>
        </select>
        <button
          type="button"
          disabled={props.busy || !props.sourceURL.trim()}
          class="rounded-md bg-surface-raised-base px-3 py-1.5 text-12-medium text-text-strong disabled:opacity-50"
          onClick={props.add}
        >
          Add
        </button>''',
    '''        <TextInputV2
          appearance="base"
          value={props.sourceURL}
          onInput={(event) => props.setURL(event.currentTarget.value)}
          placeholder="https://… or github:owner/repository"
          aria-label="Marketplace source URL"
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
        />
        <TextInputV2
          appearance="base"
          value={props.sourceName}
          onInput={(event) => props.setName(event.currentTarget.value)}
          placeholder="Display name"
          aria-label="Marketplace source display name"
        />
        <SelectV2
          options={["community", "private"] as MarketplaceConfiguredTrust[]}
          current={props.sourceTrust}
          appearance="base"
          aria-label="Marketplace source trust"
          onSelect={(value) => value && props.setTrust(value)}
        />
        <ButtonV2 type="button" variant="neutral" disabled={props.busy || !props.sourceURL.trim()} onClick={props.add}>
          Add
        </ButtonV2>''',
    "source controls",
)
text = replace(
    text,
    '<div class="flex items-center justify-between gap-4 rounded-lg border border-border-weak bg-surface-base p-3">',
    '<div data-slot="marketplace-source-card" class="flex items-center justify-between gap-4 rounded-lg p-3">',
    "source card",
)
text = replace(
    text,
    '''                  <button
                    type="button"
                    disabled={props.busy || locked}
                    class="rounded-md px-2 py-1 text-12-medium text-text-base hover:bg-surface-raised-base-hover disabled:opacity-40"
                    onClick={() => props.remove(source)}
                  >
                    Remove
                  </button>''',
    '''                  <ButtonV2
                    type="button"
                    size="small"
                    variant="ghost-muted"
                    disabled={props.busy || locked}
                    onClick={() => props.remove(source)}
                  >
                    Remove
                  </ButtonV2>''',
    "source remove button",
)

path.write_text(text)

css = '''[data-component="marketplace-panel"] {
  box-sizing: border-box;
  color: var(--v2-text-text-base);
  background: var(--v2-background-bg-base);
}

[data-component="marketplace-panel"] .text-text-strong,
[data-component="marketplace-panel"] .text-text-base {
  color: var(--v2-text-text-base);
}

[data-component="marketplace-panel"] .text-text-weak {
  color: var(--v2-text-text-muted);
}

[data-component="marketplace-panel"] [data-slot="marketplace-header"] {
  flex: none;
  padding: 40px 40px 20px;
  background: linear-gradient(to bottom, var(--v2-background-bg-base) calc(100% - 12px), transparent);
}

[data-component="marketplace-panel"] [data-slot="marketplace-title"] {
  font-size: 15px;
  font-weight: 640;
  line-height: 1;
  color: var(--v2-text-text-base);
}

[data-component="marketplace-panel"] [data-slot="marketplace-subtitle"],
[data-component="marketplace-panel"] [data-slot="marketplace-toolbar"] {
  color: var(--v2-text-text-muted);
}

[data-component="marketplace-panel"] [data-slot="marketplace-tabs"] {
  flex: none;
  margin: 0 40px;
  border-color: var(--v2-border-border-base);
}

[data-component="marketplace-panel"] [data-slot="marketplace-content"] {
  box-sizing: border-box;
  padding: 12px 40px 40px;
}

[data-component="marketplace-panel"] [data-slot="marketplace-pane"],
[data-component="marketplace-panel"] [data-slot="marketplace-source-form"],
[data-component="marketplace-panel"] [data-slot="marketplace-source-card"],
[data-component="marketplace-panel"] [data-slot="marketplace-component-list"],
[data-component="marketplace-panel"] [data-slot="marketplace-modal"] {
  border: 0;
  background-color: var(--v2-background-bg-layer-01);
  box-shadow: inset 0 0 0 0.5px var(--v2-border-border-muted);
}

[data-component="marketplace-panel"] [data-slot="marketplace-filters"] {
  border-color: var(--v2-border-border-base);
}

[data-component="marketplace-panel"] [data-slot="marketplace-filters"] [data-component="text-input-v2"] {
  width: auto;
  min-width: 0;
  flex: 1 1 auto;
}

[data-component="marketplace-panel"] [data-slot="marketplace-filters"] [data-component="select-v2-root"],
[data-component="marketplace-panel"] [data-slot="marketplace-filters"] [data-component="select-v2"] {
  width: 7rem;
  flex: none;
}

[data-component="marketplace-panel"] [data-slot="marketplace-source-form"] [data-component="text-input-v2"],
[data-component="marketplace-panel"] [data-slot="marketplace-source-form"] [data-component="select-v2-root"],
[data-component="marketplace-panel"] [data-slot="marketplace-source-form"] [data-component="select-v2"] {
  width: 100%;
  min-width: 0;
}

[data-component="marketplace-panel"] [data-slot="marketplace-list-item"] {
  color: var(--v2-text-text-base);
  outline: none;
  transition: background-color 85ms ease-out;
}

[data-component="marketplace-panel"] [data-slot="marketplace-list-item"]:hover {
  background-color: var(--v2-overlay-simple-overlay-hover);
}

[data-component="marketplace-panel"] [data-slot="marketplace-list-item"][data-selected] {
  background-color: var(--v2-background-bg-layer-02);
}

[data-component="marketplace-panel"] [data-slot="marketplace-list-item"]:focus-visible {
  outline: 2px solid var(--v2-border-border-focus);
  outline-offset: -2px;
}

[data-component="marketplace-panel"] [data-slot="marketplace-status"] {
  color: var(--v2-text-text-muted);
  background-color: var(--v2-background-bg-layer-02);
  box-shadow: inset 0 0 0 0.5px var(--v2-border-border-muted);
}

[data-component="marketplace-panel"] [data-slot="marketplace-component-list"] > div {
  border-color: var(--v2-border-border-base);
}

[data-component="marketplace-panel"] [data-slot="marketplace-modal-backdrop"] {
  background: color-mix(in srgb, var(--v2-background-bg-base) 82%, transparent);
}

[data-component="marketplace-panel"] [data-slot="marketplace-modal"] {
  box-shadow: var(--v2-elevation-floating);
}

@media (max-width: 760px) {
  [data-component="marketplace-panel"] [data-slot="marketplace-header"] {
    padding: 24px 24px 16px;
  }

  [data-component="marketplace-panel"] [data-slot="marketplace-tabs"] {
    margin-inline: 24px;
  }

  [data-component="marketplace-panel"] [data-slot="marketplace-content"] {
    padding: 12px 24px 24px;
  }
}
'''
Path("packages/app/src/components/marketplace-dialog.css").write_text(css)
