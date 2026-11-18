import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "@opencode/ui/theme"
import type { Marketplace } from "@opencode/schema/marketplace"
import { transition, type State, type Event } from "./logo-machine"

export function MarketplaceLogo(props: { item: Pick<typeof Marketplace.Item.Encoded, "name" | "icon"> }) {
  const theme = useTheme()
  const source = () =>
    theme.mode() === "dark"
      ? (props.item.icon?.["src-dark"] ?? props.item.icon?.["src-light"])
      : props.item.icon?.["src-light"]
  const initial = () => Array.from(props.item.name.trim())[0]?.toLocaleUpperCase() ?? ""
  return (
    <div
      class="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded bg-background-base"
      aria-hidden="true"
    >
      <span>{initial()}</span>
      <Show when={source()} keyed>
        {(src) => <LogoImage src={src} />}
      </Show>
    </div>
  )
}

function LogoImage(props: { src: string }) {
  const [state, setState] = createStore<{ status: State }>({ status: "loading" })
  const dispatch = (event: Event) => setState("status", (status) => transition(status, event))
  return (
    <Show when={state.status !== "failed"}>
      <img
        src={props.src}
        alt=""
        width="32"
        height="32"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        class="absolute inset-0 size-full object-contain bg-background-base"
        classList={{ "opacity-0": state.status !== "ready" }}
        onLoad={() => dispatch("loaded")}
        onError={() => dispatch("failed")}
      />
    </Show>
  )
}
