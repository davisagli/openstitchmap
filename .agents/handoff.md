# OpenStitchMap Handoff

## Project state

- Greenfield Vite + React + TypeScript app for turning OSM-style vector data into a cross stitch chart.
- Data sources currently supported:
  - Hosted vector tiles via OpenFreeMap TileJSON
  - PMTiles URL
  - Seattle-inspired local demo source
- Main Seattle presets live in `src/core/tiles/presets.ts`.
- The app builds successfully with `npm run build`.

## Current product behavior

- Pattern fills are compiled from polygon features.
- Roads/waterways/boundaries/rail render as backstitch.
- POIs render as markers.
- There is a chart preview and a stitched preview.
- The sidebar currently exposes:
  - dataset / preset / PMTiles URL
  - tile zoom / tile span
  - pattern width / height
  - stitch detail (`low` / `medium` / `high`)
  - backstitch smoothing (`soft` / `balanced` / `strong`)
  - fabric count
  - include minor roads
  - include POI labels

## Important files

- `src/app/App.tsx`
  - Main UI and data-loading flow.
  - Runs `curateFeatures(...)` before `compilePattern(...)`.
- `src/core/pattern/curateFeatures.ts`
  - Main stitch-aware filtering / simplification pass.
  - Contains polygon filtering, marker budgeting, line thinning, snapped road graph logic, graph-role heuristics, and primary-corridor collapse.
- `src/core/pattern/compilePattern.ts`
  - Compiles curated features into pattern cells / backstitch / markers.
  - Also contains backstitch path snapping + simplification.
- `src/core/tiles/vectorTileDecoder.ts`
  - Shared vector tile normalization.
  - Important for layer/tag normalization, especially transportation classes.

## Current road-graph approach

- Road candidates are projected into stitch-grid space and rasterized to grid cells.
- The snapped road graph currently tracks:
  - per-candidate cell paths
  - node degrees
  - candidate roles: `corridor`, `connector`, `duplicate`, `local`
  - candidate importance
  - duplicate-to-anchor mapping for primary corridors
- Primary roads are classified first, then primary duplicates are collapsed after graph analysis.
- Secondary/link roads with higher graph importance can be kept as connectors before the local thinning pass.
- Backstitch output is then snapped and simplified again in `compilePattern.ts` so diagonals stay diagonal instead of turning into staircase-like 90-degree jogs.

## What looks better now

- Seattle hosted preset is much less cluttered than the initial raw-vector version.
- Multi-lane overlap is reduced compared with the early passes.
- Sidewalk-like paths are more aggressively suppressed when they shadow stronger roads.
- Some missing-link behavior improved after the snapped graph / connector preservation pass.
- Backstitch diagonals look cleaner after the compile-time line simplification pass.

## What still looks rough

- Major freeway-style corridors are still heuristic, not fully topological.
- Some ramps / joins are still a little arbitrary: better than before, but not yet confidently “correct”.
- Primary corridor collapse is still based on similarity + graph role heuristics, not a true corridor-spine extraction.
- There is no dedicated diagnostics UI yet for graph role counts or why a specific road survived/dropped.

## Most promising next steps

1. Add explicit road-role diagnostics in the UI:
   - counts for `corridor`, `connector`, `duplicate`, `local`
   - maybe a short textual explanation of the current graph pass
2. Improve graph-role scoring around links/ramps:
   - better distinguish “useful join into arterial” from “parallel lane fragment”
3. Split duplicate handling into:
   - “merge into corridor”
   - “discard outright”
4. Make primary corridor selection more corridor-aware at junctions:
   - choose a corridor spine through major nodes, not just pairwise similarity
5. Consider making road-graph heuristics inspect `class`, `subclass`, or `*_link` values more directly in the importance score.

## Useful implementation notes

- `classifyLine(...)` in `compilePattern.ts` now includes link-road values such as:
  - `motorway_link`
  - `trunk_link`
  - `primary_link`
  - `secondary_link`
  - `tertiary_link`
- The user noticed and cared about:
  - multi-lane primary-road clutter
  - sidewalks shadowing roads
  - weird missing joins
  - 90-degree backstitch artifacts where diagonals should appear
- Seattle hosted preset has been the main visual validation target.

## Last validated state

- In-browser target: `http://127.0.0.1:4173/`
- Last manually checked preset:
  - dataset: hosted vector tiles
  - area preset: Seattle Waterfront
  - stitch detail: medium
  - backstitch smoothing: balanced (the browser was previously toggled to strong during one check, but latest validation was back on balanced)
- Build status:
  - `npm run build` passed
