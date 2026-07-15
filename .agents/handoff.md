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
- Roads, waterways, and rail render as backstitch. Administrative boundaries are excluded entirely.
- Stream backstitch is clipped out where it overlaps a rendered water polygon.
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
  - road detail (`Low` / `Medium` / `High`)
  - preview mode (`chart` / `stitched`)
  - export PNG
- The legend is now the primary feature-filter UI:
  - single container, ordered as fills first, then ways, then POIs
  - each legend card is a toggle button
  - line and marker toggles now reuse compiled overlays instead of re-running the full pipeline
  - fill toggles still rebuild cells, but no longer re-run curation or overlay compilation
- Source diagnostics live at the bottom in a collapsed `<details>` section with a short summary line.
- Rendering performance is materially better than the previous pass:
  - polygon fills are projected once and sampled through a per-cell polygon index
  - the fifth center sample is now lazy and only runs for mixed cells that need a tiebreaker
  - preview/chart updates are staged as curate -> compile base assets -> apply legend visibility

## Important files

- `src/app/App.tsx`
  - Main UI and data-loading flow.
  - Implements slippy-map pan/zoom behavior.
  - Splits expensive work into prepared viewport data, compiled base assets, and visible pattern derivation.
  - Line/marker legend toggles now filter cached overlays; fill toggles recompile cells only.
- `src/core/pattern/curateFeatures.ts`
  - Main stitch-aware filtering / simplification pass.
  - Contains polygon filtering, marker budgeting, line thinning, snapped road graph logic, graph-role heuristics, and primary-corridor collapse.
- `src/core/pattern/compilePattern.ts`
  - Compiles curated features into pattern cells / backstitch / markers.
  - Polygon fill compilation now operates in projected grid space with a cell-local polygon index.
  - Exposes split helpers for cells, overlays, and final document assembly.
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

- Road density now comes primarily from the vector tile pyramid instead of the old graph-growth budget.
- Hosted/PMTiles loading can fetch road-like layers at a different zoom than fills/POIs. For the hosted OpenFreeMap source, `n` is capped at the source max zoom of 14.
- The road-detail slider has three settings:
  - `Low`: roads from `n - 2`
  - `Medium`: roads from `n - 1`
  - `High`: roads from `n`
- Road features use source-tile geometry during curation and are still snapped/simplified during final backstitch compilation.
- Vector-tile feature IDs are tile-qualified, so clipped high-zoom road fragments no longer overwrite each other by source feature id.
- Parallel road/rail corridors are collapsed before rendering, but the current collapse no longer averages geometry into a new centerline. It keeps the anchor source geometry, drops overlapping duplicate segments, and preserves non-overlapping connector stubs when they span rendered grid cells.
- `*_link` roads participate in parallel-corridor matching so freeway ramps/links can be considered part of a corridor while their useful connector tails survive as stubs.
- The parallel-corridor matcher uses a spatial index of accepted anchors plus cached rasterized cells/occupancy maps to avoid broad pairwise raster checks at high road detail.
- Route-centerline extraction was removed from the active pipeline because it did little in practice and could create unstable geometry.
- In source-zoom mode, all remaining road-like candidates are selected after collapse; the old graph-growth selector remains available for non-source-zoom mode.
- Source-zoom road rendering disables the final single-component road prune so legitimate tile-selected road pieces are not discarded solely for being disconnected.
- Selected road geometry is still endpoint-snapped before compilation. Route endpoints on the viewport edge are not pulled inward.
- Compile-time Douglas-Peucker simplification remains enabled for roads so long diagonals do not become blocky staircases.

## Continuous rail and stream approach

- Railways and streams are now treated as atomic continuous-line candidates during curation.
- A candidate is either kept whole or discarded as a near-complete duplicate; the generic segment-by-segment thinning pass can no longer punch gaps through its interior.
- Rail and stream occupancy are tracked separately, so a nearby road cannot accidentally suppress either network.
- After whole-candidate selection, near-touching endpoints snap to another selected line of the same kind. Rail uses a 2-cell radius and streams use a 1.5-cell radius.
- Endpoints on the viewport edge are left in place so offscreen continuations are not pulled inward.
- Stream runs are still clipped where they cross rendered water polygons before continuity selection.
- Parallel railway collapse still happens before this pass.

## What looks better now

- Seattle hosted preset is much less cluttered than the initial raw-vector version.
- Coastlines / fill boundaries can now be softened with conservative 3/4 stitches instead of quarter-stitch fringe.
- The stitched preview reads more like a finished physical product through fabric texture,
  dimensional floss, softer cross-stitch shadows, and restrained stitch irregularity.
- Switching between chart and stitched modes no longer changes the preview dimensions.
- Multi-lane overlap is reduced compared with the early raw-vector passes.
- Road detail now changes the source zoom for road-like layers instead of expanding a manually curated graph budget.
- Sidewalk-like paths are more aggressively suppressed when they shadow stronger roads.
- Source-zoom road rendering keeps disconnected tile-selected road pieces instead of pruning to one component.
- Backstitch diagonals look cleaner after the compile-time line simplification pass.
- Railways and streams no longer lose arbitrary interior segments to overlap thinning, and small same-network endpoint misses are repaired before rendering.
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
- Parallel-way collapse is proximity/grid-overlap based, not a true medial-axis or corridor-spine algorithm.
- Connectivity is measured after rasterization into stitch-grid cells. A road can be geographically connected but miss by a cell, which is why endpoint snapping and the interstate bridge radius still exist.
- High road detail can still be heavier because source tiles expose many more road fragments, though the parallel-corridor matcher now uses a spatial index and cached rasterization.
- There is no dedicated diagnostics UI yet for why a specific road survived, collapsed, or was excluded.
- The workspace intro copy still says “Use the grouped legend below…” even though the explicit subgroup headings were removed. That copy is functionally fine but could be tightened.
- The slippy map still works on a stitch-grid abstraction, not true continuous cartographic rendering, so motion can feel a little approximate when rerenders are fast/slow.
- The realistic fabric/floss treatment is still experimental and may need tuning across
  palettes, pattern dimensions, and display pixel densities.
- `chart -> stitched` is still noticeably slower than the reverse direction, so the draw path is now the next obvious bottleneck.

## Most promising next steps

1. Attack remaining preview draw cost:
   - cache rendered chart/stitched layers or pre-render to offscreen surfaces
   - consider moving compile/curation to a worker if interaction latency is still noticeable under heavier views
2. Continue tuning fractional-fill heuristics:
   - inspect cases where the new adjacency rule is too strict or too loose
   - consider whether different fill classes should allow different fractional-stitch aggressiveness
3. Add road diagnostics that explain source zoom, parallel-collapse matches/stubs, endpoint snapping, and final rendered segments.
4. Continue profiling high road detail if interaction still feels slow; next likely targets are compile-time backstitch simplification and preview drawing.
5. Revisit whether the final single-component backstitch prune should remain disabled for source-zoom roads or become a more nuanced multi-component filter.
7. Add focused rail/stream continuity diagnostics or fixtures, especially for fragmented tile-source geometry and water-area clipping.
8. If UI polish continues:
   - consider slightly tightening the workspace intro text
   - consider whether diagnostics summary belongs inline with legend/footer copy instead of as its own row
   - consider a future export surface beyond PNG once the pattern format stabilizes
9. Continue validating the realistic stitched treatment:
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
- Stitch detail is hidden in the UI and defaults to `high`.
- Road density is independent of stitch detail. `roadNetworkDetail` is a 0/1/2 slider for Low/Medium/High road source zoom offsets.
- The road curation/rendering pipeline intentionally favors visual continuity and stitchability over geographic fidelity.
- `continuousLineKind(...)` covers `rail` and `stream`; these kinds bypass `thinLineCandidate(...)` and use whole-candidate duplicate rejection plus same-kind endpoint snapping.

## Last validated state

- In-browser target: `http://127.0.0.1:5173/`
- Last manually checked state:
  - OpenFreeMap Seattle waterfront default
  - stitch detail hidden in the UI and defaulted to high
  - preview mode: chart and stitched
  - both preview modes use the same canvas and clipped viewport dimensions
  - stitched mode uses the realistic woven-fabric/floss treatment
  - conservative 3/4 stitches appear only where neighboring cells corroborate the smoothed edge
  - legend order: fills, then ways, then POIs
  - legend cards are compact and show DMC floss codes
  - extra vertical space sits below the legend rather than inflating the preview frame
  - render interactions were re-checked after the performance pass
  - road-detail slider defaults to `Medium`
  - boundaries are absent and streams are omitted over water fills
  - rail and stream candidates are retained whole and snap near-touching same-kind endpoints
  - route-centerline extraction has been removed from the active road pipeline
  - parallel-corridor collapse keeps anchor geometry and preserves rendered connector stubs
- Build status:
  - `npm run build` passed
- `git diff --check` passed after the latest source-zoom road pass.

## Recent commits

- `646020d` - `Refine road network curation`
- `0f6dd8b` - `Add double-click zoom and preview attribution`
- `0283be5` - `Add place search for map navigation`
- `f1dba48` - `Merge rendering performance improvements`
- `74d256b` - `Improve rendering performance`
- `518c7ee` - `Make fabric count a radio choice`
- `c120d49` - `Improve stitched product preview`
- `b62b28e` - `Add 3/4 stitches to smooth contours`
- `7a5685c` - `Update project handoff`
- `cbfb35d` - `Refine stitch preview UI`
- `896b8b4` - `Add slippy map preview interactions`
- `a8b3893` - `Initial OpenStitchMap prototype`
