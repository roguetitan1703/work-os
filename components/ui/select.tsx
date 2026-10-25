"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// The app's own dropdown (Base UI Select, themed through the same tokens as the rest of the UI), so lists look right
// in both themes instead of the browser's native one. It takes the same children as a native <select> (<option value
// disabled>), the same `value` / `defaultValue` / `name` / `disabled` / `aria-label`, and calls `onChange` with
// `{ target: { value } }`, so a call site only changes the tag. Keyboard: Enter / Space / arrows open it, arrows move,
// type-ahead jumps, Enter picks, Escape closes. The trigger is a real button (tappable at 44px where the caller sizes it),
// the list scrolls on touch. In a form it submits through a hidden input under `name`, like a native select.

export type SelectChangeEvent = { target: { value: string }; currentTarget: { value: string } }

type Opt = { value: string; label: React.ReactNode; disabled: boolean }

// '' (the usual "All" / "none" option) is a valid value for us; Base UI uses null for "nothing chosen", so '' travels as a marker.
const EMPTY = "\u0000empty"
const enc = (v: string) => (v === "" ? EMPTY : v)
const dec = (v: string) => (v === EMPTY ? "" : v)

function textOf(n: React.ReactNode): string {
  if (n == null || typeof n === "boolean") return ""
  if (typeof n === "string" || typeof n === "number") return String(n)
  if (Array.isArray(n)) return n.map(textOf).join("")
  if (React.isValidElement(n)) return textOf((n.props as { children?: React.ReactNode }).children)
  return ""
}

function collect(children: React.ReactNode, out: Opt[] = []): Opt[] {
  React.Children.forEach(children, (c) => {
    if (!React.isValidElement(c)) return
    const p = c.props as { value?: string | number; disabled?: boolean; children?: React.ReactNode }
    if (c.type === React.Fragment || c.type === "optgroup") collect(p.children, out)
    else if (c.type === "option") out.push({ value: p.value != null ? String(p.value) : textOf(p.children), label: p.children, disabled: !!p.disabled })
  })
  return out
}

type Props = {
  value?: string | number
  defaultValue?: string | number
  onChange?: (e: SelectChangeEvent) => void
  name?: string
  id?: string
  disabled?: boolean
  required?: boolean
  className?: string
  children?: React.ReactNode
  onClick?: React.MouseEventHandler<HTMLElement>
  /** No arrow: for the tiny inline pickers in task rows, where every pixel counts (the hover border shows it is a control). */
  compact?: boolean
  "aria-label"?: string
  "data-assignee-picker"?: boolean
}

function Select({ value, defaultValue, onChange, name, id, disabled, required, className, children, onClick, compact, "aria-label": ariaLabel, ...rest }: Props) {
  const options = collect(children)
  const items = options.map((o) => ({ value: enc(o.value), label: o.label }))
  const controlled = value !== undefined
  return (
    <SelectPrimitive.Root
      items={items}
      value={controlled ? enc(String(value)) : undefined}
      defaultValue={!controlled && defaultValue !== undefined ? enc(String(defaultValue)) : undefined}
      onValueChange={(v) => {
        const s = dec(String(v ?? ""))
        onChange?.({ target: { value: s }, currentTarget: { value: s } })
      }}
      name={name}
      id={id}
      disabled={disabled}
      required={required}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        aria-label={ariaLabel}
        onClick={onClick}
        {...rest}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center justify-between gap-1 rounded-md border border-input bg-background px-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-popup-open:border-ring dark:bg-input/30",
          className,
        )}
      >
        <SelectPrimitive.Value className="min-w-0 flex-1 truncate" />
        {!compact && (
          <SelectPrimitive.Icon className="shrink-0 opacity-60">
            <ChevronDownIcon className="size-3.5" />
          </SelectPrimitive.Icon>
        )}
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        {/* Clicks in the list belong to the list: React would otherwise pass them to a clickable row the select sits in. */}
        <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-[200] outline-none" onClick={(e) => e.stopPropagation()}>
          <SelectPrimitive.Popup
            data-slot="select-content"
            className="max-h-[min(20rem,var(--available-height))] min-w-[max(var(--anchor-width),9rem)] max-w-[min(24rem,calc(100vw-1rem))] origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
          >
            <SelectPrimitive.List>
              {options.map((o) => (
                <SelectPrimitive.Item
                  key={o.value}
                  value={enc(o.value)}
                  data-value={o.value}
                  disabled={o.disabled}
                  className="relative flex min-h-9 cursor-default select-none items-center gap-2 rounded-lg py-1.5 pr-8 pl-2.5 text-sm outline-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted data-highlighted:text-foreground md:min-h-8"
                >
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">{o.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
                    <CheckIcon className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

export { Select }
