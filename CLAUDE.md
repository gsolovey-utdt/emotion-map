# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

Static files only — no build step. Serve with any static server:

```
# VS Code Live Server: open folder, click "Go Live"
# Python: python -m http.server 8080
# Node:   npx serve .
```

Then open `index.html` (student app) or `admin.html?token=nype-admin-2026` (teacher panel).

Separate classes with a query parameter:
```
index.html?class=nype-2026-clase1
admin.html?class=nype-2026-clase1&token=nype-admin-2026
```

Append `&debug=1` to expose `window.emotionMapDebug` in the console.

## Architecture

Single-page static app. No framework, no bundler.

| File | Role |
|---|---|
| `index.html` | Student flow: 4 screens (start → task × 4 → results → learning) |
| `app.js` | All student logic — one IIFE, ~700 lines |
| `admin.html` | Teacher panel: heatmaps + table + CSV export + delete. Self-contained with inline `<script>`. |
| `styles.css` | Shared styles for both pages |
| `assets/body-template.png` | Visual body silhouette drawn on the base canvas |
| `assets/body-mask.png` | Binary mask that enforces painting within the body |
| `assets/body-outline.png` | Outline overlay drawn on top of paint |

### Data flow

1. Student paints on a 360×620 canvas (`paint-canvas` layered over `base-canvas`).
2. On save, the painted canvas is downsampled to a 120×207 binary bitset and base64-encoded (`mask_bits_b64`).
3. Four rows are inserted into Supabase (`emotion_map_responses`): 2 emotions × 2 map types (activation / deactivation).
4. Heatmaps are built client-side: for each pixel, `(activation_count − deactivation_count) / participant_count` maps to a warm/cool color scale.

### Canvas layers (task screen)

```
base-canvas  (z=1): body template image + gradient background
paint-canvas (z=2): user strokes, clipped to body-mask via destination-in composite
maskCanvas        : off-screen, holds body-mask at 360×620 for stroke clipping
storeMaskCanvas   : off-screen, holds body-mask at 120×207 for bit encoding
```

### Undo stack

Stores `{ bits: Uint8Array (120×207 bitset), mapType }` — not full ImageData — to keep memory ~3 KB per entry instead of ~900 KB. Undo re-renders from the bitset via `restoreFromBits()`.

### Input handling

Pointer Events only (`pointerdown/move/up/leave/cancel` on the canvas). `setPointerCapture` ensures stroke continues outside the canvas bounds. No mouse or touch fallbacks needed — `touch-action: none` on `#paint-canvas` prevents scroll interference.

### Privacy

`participant_id` is never stored in plain text. `hashParticipantId(name, classId)` produces a 12-hex SHA-256 truncation (deterministic per class, opaque to outsiders). The student-facing SELECT omits `participant_id` entirely; admin SELECT retains it for teacher use.

## Supabase

Project: `irryksaoygdklwtsjsru.supabase.co`  
Table: `emotion_map_responses`  
Auth: `anon` key (public, client-side). RLS policies:
- INSERT: open to anon
- SELECT: open to anon (returns hashed `participant_id` + `session_id`)
- DELETE: open to anon (used only from token-protected `admin.html`)

Schema (from README):
```sql
create table emotion_map_responses (
  id uuid default gen_random_uuid() primary key,
  created_at timestamptz default now(),
  participant_id text not null default 'Anónimo',
  session_id text not null,
  class_id text not null default 'default',
  emotion text not null,
  map_type text not null check (map_type in ('activation', 'deactivation')),
  mask_bits_b64 text not null,
  store_width integer not null,
  store_height integer not null,
  painted_pixels integer not null default 0,
  no_change boolean not null default false,
  body_mask_version text not null default 'paper_ref_v1'
);
```

## Key constants (app.js)

| Constant | Value | Meaning |
|---|---|---|
| `STORE_WIDTH/HEIGHT` | 120 × 207 | Bitset resolution for storage |
| `CANVAS_WIDTH/HEIGHT` | 360 × 620 | Display canvas resolution |
| `BODY_MASK_VERSION` | `"paper_ref_v1"` | Used to filter rows; bump if mask changes |
| `APP_VERSION` | `"20260519-0100"` | Cache-busting suffix for assets and scripts |
| `ADMIN_TOKEN` | `"nype-admin-2026"` | In `admin.html` — change before sharing |

## Versioning / cache-busting

`APP_VERSION` is referenced in three places — keep them in sync when bumping:
- `app.js` → `const APP_VERSION`
- `index.html` → `?v=` on both `styles.css` and `app.js` script tag
- `admin.html` → `?v=` on `styles.css` link
