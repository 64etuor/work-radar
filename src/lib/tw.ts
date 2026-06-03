import { extendTailwindMerge } from "tailwind-merge";

/**
 * App-local tailwind-merge instance that understands `@utility typo-*` recipes
 * (src/styles/typography.css). Each typo-* sets font-size + line-height +
 * font-weight + letter-spacing (mono-label also font-family), so we register a
 * `typo` class group that conflicts bidirectionally with those built-in groups.
 * Result: `cn("text-base …", "typo-title-md")` → typo-title-md wins (built-ins
 * stripped), independent of compiled-cascade order. See docs/areas/typography.md.
 */
const TYPO_SUFFIXES = [
  "title-md",
  "title-sm",
  "body-md",
  "body-strong",
  "label-sm",
  "caption-sm",
  "mono-label",
  "micro",
];

export const twMergeTypo = extendTailwindMerge<"typo">({
  extend: {
    classGroups: {
      typo: [{ typo: TYPO_SUFFIXES }],
    },
    conflictingClassGroups: {
      typo: ["font-size", "leading", "font-weight", "tracking", "font-family"],
      "font-size": ["typo"],
      leading: ["typo"],
      "font-weight": ["typo"],
      tracking: ["typo"],
      "font-family": ["typo"],
    },
  },
});
