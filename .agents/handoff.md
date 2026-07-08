# OpenStitchMap Handoff

## Project state

- Greenfield Vite + React + TypeScript app for turning OSM-style vector data into a cross stitch chart.
- Current UX is OpenFreeMap-only, centered on the Seattle waterfront by default.
- Code paths still exist for:
  - hosted vector tiles via OpenFreeMap TileJSON
  - PMTiles URL
  - Seattle-inspired local demo source
  but PMTiles/demo selection is intentionally hidden in the UI for now.
- Main Seattle defaults still originate from `src/core/tiles/presets.ts`.
- The app builds successfully with `npm run build`.

## Current product behavior

- Pattern fills are compiled from polygon features.
- Area fills can now use conservative 3/4 stitches to smooth contours:
  - only cells with a single-corner minority fill are eligible
  - the minority accent color is preserved in both chart and stitched previews
  - a 3/4 stitch is only kept when both the accent side and the dominant side match adjacent cells, so the feature smooths an existing edge instead of creating extra detail
- Roads/waterways/boundaries/rail render as backstitch.
- POIs render as French-knot-style markers.
- There is a printable chart preview and a realistic stitched product preview.
- Chart and stitched previews now use the same cell size and viewport footprint, so the
  pattern does not move when toggling modes.
- The preview now behaves like a slippy map:
  - drag to pan
  - mouse-wheel zoom
  - zoom anchors under the cursor
  - preview uses an overscanned canvas clipped by a viewport
  - transient CSS translate/scale is used during rerenders so pan/zoom does not snap back immediately
- The sidebar currently exposes only:
  - pattern width / height
  - stitched size
  - fabric count
  - stitch detail (`low` / `medium` / `high`)
  - preview mode (`chart` / `stitched`)
  - export PNG
- The legend is now the primary feature-filter UI:
  - single container, ordered as fills first, then ways, then POIs
  - each legend card is a toggle button
  - toggling a legend item recompiles the pattern without that fill/line/marker class
- Source diagnostics live at the bottom in a collapsed `<details>` section with a short summary line.

## Important files

- `src/app/App.tsx`
  - Main UI and data-loading flow.
  - Implements slippy-map pan/zoom behavior.
  - Runs `curateFeatures(...)` before `compilePattern(...)`.
  - Applies legend-toggle filtering before final compilation.
- `src/core/pattern/curateFeatures.ts`
  - Main stitch-aware filtering / simplification pass.
  - Contains polygon filtering, marker budgeting, line thinning, snapped road graph logic, graph-role heuristics, and primary-corridor collapse.
- `src/core/pattern/compilePattern.ts`
  - Compiles curated features into pattern cells / backstitch / markers.
  - Also contains backstitch path snapping + simplification.
  - Contains the conservative 3/4-stitch eligibility pass for polygon fills.
  - Backstitch smoothing is no longer user-configurable; the previous balanced behavior is now the fixed behavior.
- `src/core/tiles/vectorTileDecoder.ts`
  - Shared vector tile normalization.
  - Important for layer/tag normalization, especially transportation classes.
- `src/render/drawChartPreview.ts`
  - Draws chart preview cells, backstitches, and French-knot-style marker rendering.
  - Renders 3/4 stitches as diagonal two-color chart cells.
- `src/render/drawStitchPreview.ts`
  - Draws the realistic stitched preview on woven fabric with visible cloth holes.
  - Uses thick, slightly slack floss with restrained shadows for filled cross-stitch areas.
  - Keeps backstitch crisp and renders dimensional French-knot-style markers.
  - Renders 3/4 stitches with both dominant and adjacent-color floss.
- `src/core/palette.ts`
  - Fill / line / marker style definitions, including DMC floss codes used in the legend.

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
- Coastlines / fill boundaries can now be softened with conservative 3/4 stitches instead of quarter-stitch fringe.
- The stitched preview reads more like a finished physical product through fabric texture,
  dimensional floss, softer cross-stitch shadows, and restrained stitch irregularity.
- Switching between chart and stitched modes no longer changes the preview dimensions.
- Multi-lane overlap is reduced compared with the early passes.
- Sidewalk-like paths are more aggressively suppressed when they shadow stronger roads.
- Some missing-link behavior improved after the snapped graph / connector preservation pass.
- Backstitch diagonals look cleaner after the compile-time line simplification pass.
- The UI is much quieter than earlier versions:
  - no dataset/source chooser in the active UX
  - no tile zoom/tile span controls
  - no backstitch smoothing selector
  - no POI-label toggle
  - no JSON export
  - no explicit sidebar section headings
  - no explicit legend subgroup headings
- The legend now reads closer to the map:
  - fill swatches resemble stitched fill marks
  - way swatches resemble angled backstitch segments
  - POI swatches resemble French knots
  - marker legend entries show DMC floss codes instead of the text `French knot`

## What still looks rough

- 3/4 stitch smoothing is intentionally conservative and may still leave some edges fully stepped where a human designer might choose a fractional stitch.
- Major freeway-style corridors are still heuristic, not fully topological.
- Some ramps / joins are still a little arbitrary: better than before, but not yet confidently “correct”.
- Primary corridor collapse is still based on similarity + graph role heuristics, not a true corridor-spine extraction.
- There is no dedicated diagnostics UI yet for graph role counts or why a specific road survived/dropped.
- The workspace intro copy still says “Use the grouped legend below…” even though the explicit subgroup headings were removed. That copy is functionally fine but could be tightened.
- The slippy map still works on a stitch-grid abstraction, not true continuous cartographic rendering, so motion can feel a little approximate when rerenders are fast/slow.
- The realistic fabric/floss treatment is still experimental and may need tuning across
  palettes, pattern dimensions, and display pixel densities.

## Most promising next steps

1. Continue tuning fractional-fill heuristics:
   - inspect cases where the new adjacency rule is too strict or too loose
   - consider whether different fill classes should allow different fractional-stitch aggressiveness
2. Continue road-role diagnostics in the UI:
   - counts for `corridor`, `connector`, `duplicate`, `local`
   - maybe a short textual explanation of the current graph pass
3. Improve graph-role scoring around links/ramps:
   - better distinguish “useful join into arterial” from “parallel lane fragment”
4. Split duplicate handling into:
   - “merge into corridor”
   - “discard outright”
5. Make primary corridor selection more corridor-aware at junctions:
   - choose a corridor spine through major nodes, not just pairwise similarity
6. Consider making road-graph heuristics inspect `class`, `subclass`, or `*_link` values more directly in the importance score.
7. If UI polish continues:
   - consider slightly tightening the workspace intro text
   - consider whether diagnostics summary belongs inline with legend/footer copy instead of as its own row
   - consider a future export surface beyond PNG once the pattern format stabilizes
8. Continue validating the realistic stitched treatment:
   - check whether floss coverage stays convincing at unusually small or large pattern widths
   - tune fabric texture and stitch depth if lighter palettes lose contrast

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
  - 3/4 stitches should smooth contours only when they agree with adjacent cells
  - chart/stitched toggling should not move the pattern
  - realistic cross-stitch floss should cover filled areas without overpowering backstitch
- Seattle hosted preset has been the main visual validation target.
- Legend toggles are based on style classification:
  - polygons -> `classifyPolygon(...)`
  - lines -> `classifyLine(...)`
  - points -> `classifyMarker(...)`
- The app currently always compiles with `includeMinorRoads: true` and relies on legend toggles for hiding classes instead of a dedicated “include minor roads” control.

## Last validated state

- In-browser target: `http://127.0.0.1:5173/`
- Last manually checked state:
  - OpenFreeMap Seattle waterfront default
  - stitch detail: medium
  - preview mode: chart and stitched
  - both preview modes use the same canvas and clipped viewport dimensions
  - stitched mode uses the realistic woven-fabric/floss treatment
  - conservative 3/4 stitches appear only where neighboring cells corroborate the smoothed edge
  - legend order: fills, then ways, then POIs
  - legend cards are compact and show DMC floss codes
  - extra vertical space sits below the legend rather than inflating the preview frame
- Build status:
  - `npm run build` passed

## Recent commits

- `b62b28e` - `Add 3/4 stitches to smooth contours`
- `7a5685c` - `Update project handoff`
- `cbfb35d` - `Refine stitch preview UI`
- `896b8b4` - `Add slippy map preview interactions`
- `a8b3893` - `Initial OpenStitchMap prototype`
