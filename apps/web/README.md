# @delegate/web

Next.js App Router UI for Delegate. Design direction: calm, premium, precise; Linear crossed with a mission-control console.

```bash
pnpm --filter web dev        # http://localhost:3000
pnpm --filter web typecheck
pnpm --filter web lint
pnpm --filter web test
pnpm --filter web build
```

## Design tokens

All tokens live in `src/styles/tokens.css` as CSS custom properties and are mapped into Tailwind v4 with `@theme inline` in `src/app/globals.css`. Tailwind's default colour, radius, shadow and font-size scales are cleared, so only tokens can be used.

| Group | Tokens | Tailwind |
|---|---|---|
| Colour | `--bg`, `--surface`, `--surface-2`, `--border`, `--border-strong`, `--text`, `--text-muted`, `--text-subtle`, `--accent`, `--accent-fg`, `--accent-soft`, `--success(-soft)`, `--warning(-soft)`, `--danger(-soft)`, `--focus`, `--overlay` | `bg-surface`, `text-text-muted`, `border-border`, `bg-accent` … |
| Type | `--font-family-sans` (Instrument Sans), `--font-family-serif` (Instrument Serif), `--font-family-mono` (JetBrains Mono); `--font-size-*` / `--line-height-*` for `2xs` 11/16, `xs` 12/16, `sm` 13/20, `base` 15/24, `md` 17/26, `lg` 20/28, `xl` 24/30, `display-sm` 32/36, `display-md` 44/48, `display-lg` 60/62 | `font-serif`, `text-display-md`, `tracking-display`, `tracking-label` |
| Space | `--space-unit` 4px and `--space-1` … `--space-24`; `--content-width` 72rem | every spacing utility is a multiple of 4px; `max-w-content` |
| Radius | `--corner-xs` 3px, `sm` 4, `md` 6, `lg` 8, `xl` 12 | `rounded-xs` … `rounded-xl` |
| Elevation | `--elevation-sm`, `-md`, `-lg` (hairline plus a soft drop; stronger in dark) | `shadow-sm` … `shadow-lg` |
| Motion | `--duration-instant` 80ms, `-fast` 140ms, `-base` 220ms, `-slow` 360ms; `--easing-standard`, `-enter`, `-exit` | `ease-standard`; durations drop to 0 under `prefers-reduced-motion` |

Usage rules:

- **Fonts:** Instrument Sans for UI, Instrument Serif for display headings and large numerals, JetBrains Mono for data, IDs, paths and costs.
- **Colour:** graphite neutrals plus one signal-blue accent (primary action, focus, the current or next milestone). Amber (`warning`) is reserved for critic flags, red (`danger`) for policy denials and errors, green (`success`) for verified and allowed.
- **Motion** only shows work happening (the detected-mission chip, later the live run). No decorative animation.

## Themes

Light and dark, following the system by default. An inline script in `<head>` (`themeInitScript` in `src/lib/theme.ts`) resolves the stored preference (`localStorage["delegate-theme"]`: `light`, `dark` or `system`) before first paint and sets `data-theme` and `data-theme-preference` on `<html>`, so there is no flash. Without JavaScript, `prefers-color-scheme` still applies. The toggle and the ⌘K palette switch to the explicit opposite of the theme on screen.

## Contrast (WCAG 2.2 AA)

Checked numerically and enforced by `src/styles/tokens.test.ts` (text pairs ≥ 4.5:1, focus ring ≥ 3:1; the system-dark block must equal the explicit dark block).

| Foreground | Background | Light | Dark | Required |
|---|---|---|---|---|
| `text` | `bg` | 16.57 | 16.26 | 4.5:1 |
| `text` | `surface` | 17.77 | 15.46 | 4.5:1 |
| `text` | `surface-2` | 15.43 | 14.39 | 4.5:1 |
| `text-muted` | `bg` | 6.65 | 7.55 | 4.5:1 |
| `text-muted` | `surface` | 7.13 | 7.17 | 4.5:1 |
| `text-muted` | `surface-2` | 6.20 | 6.68 | 4.5:1 |
| `text-subtle` | `bg` | 4.91 | 5.58 | 4.5:1 |
| `text-subtle` | `surface` | 5.26 | 5.30 | 4.5:1 |
| `text-subtle` | `surface-2` | 4.57 | 4.93 | 4.5:1 |
| `accent` | `bg` | 5.75 | 7.97 | 4.5:1 |
| `accent` | `surface` | 6.16 | 7.57 | 4.5:1 |
| `accent-fg` | `accent` | 6.16 | 7.82 | 4.5:1 |
| `accent` | `accent-soft` | 5.30 | 6.78 | 4.5:1 |
| `success` | `bg` | 5.06 | 8.60 | 4.5:1 |
| `success` | `success-soft` | 4.71 | 7.18 | 4.5:1 |
| `warning` | `bg` | 5.38 | 8.83 | 4.5:1 |
| `warning` | `warning-soft` | 5.02 | 7.35 | 4.5:1 |
| `danger` | `bg` | 5.43 | 7.50 | 4.5:1 |
| `danger` | `danger-soft` | 4.85 | 6.75 | 4.5:1 |
| `focus` | `bg` | 5.75 | 7.97 | 3:1 |
| `focus` | `surface` | 6.16 | 7.57 | 3:1 |

`border` and `border-strong` are decorative hairlines (about 1.2–1.8:1). Controls are identified by their label, placeholder and surface, and the focused state uses `accent` (≥ 5.7:1).

## Accessibility

Skip link to `#main`; `header`, `nav`, `main` and `footer` landmarks; one `h1` per page with an ordered heading outline; visible `:focus-visible` rings on every interactive element; the command palette is a native modal `<dialog>` (background inert, focus kept in the search field, Escape and backdrop close, focus restored) with the combobox/listbox pattern and arrow, Home and End navigation; the detected mission is announced through a polite live region.

## Model chain status

The home page reads `config/models.json` at build time (`src/lib/model-chain-file.ts`, validated with zod in `src/lib/model-chain.ts`) and lists the keyless providers a public visitor would use. It shows configuration only: no health checks or latency until `pnpm smoke` exists. If the file is missing or invalid, the line says so.
