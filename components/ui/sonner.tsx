"use client"

import { useSyncExternalStore } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

// Phones get toasts at the top, clear of the tab bar and the sticky "Mark done" button.
const PHONE = "(max-width: 767px)"
const subscribe = (cb: () => void) => {
  const m = window.matchMedia(PHONE)
  m.addEventListener("change", cb)
  return () => m.removeEventListener("change", cb)
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const phone = useSyncExternalStore(subscribe, () => window.matchMedia(PHONE).matches, () => false)

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={phone ? "top-center" : "bottom-right"}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 8px)" }}
      duration={phone ? 2500 : 4000}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
