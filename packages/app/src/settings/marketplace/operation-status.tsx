import { Show, type Accessor } from "solid-js"
import { Loader } from "@opencode/ui/loader"
import { useLanguage } from "@/runtime/i18n/language"
import { active, type Operation } from "./operations-machine"

export function OperationStatus(props: { operation: Accessor<Operation> }) {
  const language = useLanguage()
  const progress = () => {
    const operation = props.operation()
    return operation.status === "running" || operation.status === "cancelling" ? operation.progress : undefined
  }
  const label = () => {
    const operation = props.operation()
    return operation.status === "running"
      ? language.t(`marketplace.operations.phase.${operation.phase}`)
      : language.t(`marketplace.operations.status.${operation.status}`)
  }
  return (
    <div class="flex flex-wrap items-center gap-2 text-13 leading-[var(--line-height-compact)]">
      <Show when={active(props.operation())}>
        <Loader />
      </Show>
      <span>
        {language.t(`marketplace.operations.kind.${props.operation().kind}`)} · {label()}
      </span>
      <Show when={progress()}>
        {(value) => (
          <bdi dir="ltr">
            {value().completed}
            {value().total === undefined ? "" : ` / ${value().total}`}{" "}
            {language.t(`marketplace.operations.unit.${value().unit}`)}
          </bdi>
        )}
      </Show>
    </div>
  )
}
