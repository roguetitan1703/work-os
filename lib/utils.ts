import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// The library's own type steps and radii (app/globals.css) must merge as sizes/radii, not as colours.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["label", "meta", "body", "title", "page"] }],
      rounded: [{ rounded: ["card", "control", "pill"] }],
      "min-h": [{ "min-h": ["row"] }],
      h: [{ h: ["row"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
