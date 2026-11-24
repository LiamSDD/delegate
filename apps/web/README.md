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

## Runs: storage, sessions and streaming (ADR 0005)

| Route | Purpose |
|---|---|
| `POST /api/runs` | `{ missionId: "company-xray", input: { url, focus? } }` → `201 { runId }`. Same-origin `Origin` required (CSRF), JSON only, 8 KB cap. The URL is normalised to its `https://host/` homepage; IP literals, ports, credentials and local suffixes (`localhost`, `.local`, `.internal`, `.arpa`, …) are rejected. Rate limited per guest (5/hour) and per client IP (20/hour), in memory per process; Upstash replaces this later. |
| `GET /api/runs/:id` | Run summary (status, totals, timestamps) for the session's workspace. |
| `GET /api/runs/:id/events` | Server-Sent Events. Replays events after `Last-Event-ID` (or `?after=`), then polls every 250 ms until terminal or disconnect. `id` = seq, `event` = type, `data` = the event JSON; control frames `stream.replay {count}`, `stream.live`, `stream.end`; heartbeat comments every 15 s. `204` once a terminal run is fully delivered, so `EventSource` stops reconnecting. |
| `POST /api/runs/:id/cancel` | Appends `run.failed` (`cancelled`, "cancelled by user") and aborts the in-process runner. `409` when the run already finished. |
| `GET /api/runs/:id/artifacts/:artifactId` | Latest stored content of an artifact (mirrored from `artifact.*` event payloads into `artifacts`). |

Every unknown run, foreign run or missing session answers `404`, never `403`. A run that is older than 5 minutes and silent for 2 minutes is marked `run.failed` (`worker_lost`, "worker lost") on the next read.

**Database.** With `DATABASE_URL` set, the app uses Neon through `createDb` and refuses to start if that login bypasses RLS. Without it, `src/server/db.ts` opens an embedded PGlite at `<repo>/.data/pglite` (the directory carries its own `.gitignore`), applies the real `packages/db` migrations once per boot as the bootstrap superuser, then runs `SET SESSION AUTHORIZATION delegate_app_login`. From then on every request goes through `withTenant()` (`SET LOCAL ROLE delegate_app` + `app.user_id`), so RLS, column grants and append-only triggers apply exactly as in production. Guest provisioning calls the `SECURITY DEFINER` function `create_guest_workspace()` (migration `0003`) as `delegate_app`. It creates the guest user, org, 7-day demo workspace and owner membership in one statement, so neither PGlite nor Neon needs a provisioning connection or elevated login.

**Sessions.** First run creation creates an anonymous guest who owns a demo workspace (`is_demo`, 7-day retention) and sets `delegate_session`: `base64url(payload).base64url(HMAC-SHA256)`, HTTP-only, `SameSite=Lax`, `Secure` in production, 7 days. `DELEGATE_SESSION_SECRET` (≥ 32 chars) is required in production; in development a random per-process secret is generated with a warning.

**Simulated runner.** `DELEGATE_FAKE_RUNNER=1` (ignored when `NODE_ENV=production`) replaces the runtime with a scripted dev runner so the run view can be exercised without models. Its runs carry `execution: "simulated"` in `run.created`, every text it writes says "Simulated", and the UI labels the run "Simulated · no research, no model calls".

**Run view.** `/runs/[id]` folds the streamed events with `foldRun` on the client (`src/lib/runs/run-view.ts`), so a reload rebuilds the same view. Mobile (< 768 px) collapses into Plan / Activity / Brief tabs; Brief becomes the default once an artifact exists.
