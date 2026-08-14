# OpenStitchMap Handoff

## Project state

- Greenfield Vite + React + TypeScript app for turning OSM-style vector data into a cross stitch chart.
- Current UX is OpenFreeMap-only, centered on the Seattle waterfront by default.
- Code paths still exist for:
  - hosted vector tiles via OpenFreeMap TileJSON
  - PMTiles URL
  - Seattle-inspired local demo source
  but PMTiles/demo selection is intentionally hidden in the UI for now.
- The default center still originates from `src/core/tiles/presets.ts`; the app now starts at zoom 11 independently of the preset zoom.
- The app builds successfully with `npm run build`.

## Current product behavior

- Pattern fills are compiled from polygon features.
- Area fills can now use conservative 3/4 stitches to smooth contours:
  - only cells with a single-corner minority fill are eligible
  - the minority accent color is preserved in both chart and stitched previews
  - a 3/4 stitch is only kept when both the accent side and the dominant side match adjacent cells, so the feature smooths an existing edge instead of creating extra detail
- Roads, waterways, rail, and ferry routes render as backstitch. Administrative boundaries are excluded entirely.
- OpenMapTiles `transportation` features with `class=ferry` are normalized to `route=ferry` and render as a dedicated dark navy `DMC 336` line style with their own legend toggle.
- Stream backstitch is clipped out where it overlaps a rendered water polygon.
- POIs render as French-knot-style markers.
- There is a printable chart preview and a realistic stitched product preview.
- Chart and stitched previews now use the same cell size and viewport footprint, so the
  pattern does not move when toggling modes.
- The preview now behaves like a slippy map:
  - drag to pan
  - mouse-wheel zoom uses a non-passive wheel listener, temporary cursor-anchored scale feedback, and an idle commit threshold so it feels responsive without zooming on every tiny wheel event
  - zoom anchors under the cursor
  - preview uses an overscanned canvas clipped by a viewport
  - the visible preview viewport is exactly the configured pattern width/height in cells, with the overscan canvas offset snapped to whole-cell boundaries so edge cells are not clipped mid-cell
  - transient CSS translate/scale is used during rerenders so pan/zoom does not snap back immediately
  - the initial zoom is 11 and the zoom floor is 0, so the map can be viewed at regional and world scales
- Place search is paired with a `Current location` button that uses browser geolocation to recenter the map while preserving the current zoom. Permission denial, timeout, unavailable-position, and unsupported-browser states are surfaced inline.
- The current map and pattern configuration is shareable through the URL query string. Latitude, longitude, zoom, dimensions, fabric count, stitch detail, road detail, preview mode, and hidden legend entries are restored on load and browser navigation; updates use `history.replaceState` so pan/zoom gestures do not flood browser history.
- PNG exports append a readable attribution footer for OpenFreeMap, OpenMapTiles, and OpenStreetMap contributors.
- The sidebar attribution footer includes a link to the public GitHub repository.
- The workspace and preview frame are width-constrained so the overscanned map canvas scrolls inside its own container instead of widening the mobile page. At narrow widths the search field takes its own row above the Search and Current location buttons.
- The sidebar currently exposes only:
  - pattern width / height
  - stitched size, shown quietly in inches and centimeters under fabric count
  - fabric count
  - road detail (`Low` / `Medium` / `High`)
  - preview mode (`chart` / `stitched`)
  - export PNG
- The legend is now the primary feature-filter UI:
  - single container, ordered as fills first, then ways, then POIs
  - each legend card is a toggle button
  - usage counts are rounded for display, and legend columns are wide enough to avoid count overflow
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
  - Parses, validates, restores, and continuously writes shareable query-string state.
  - Handles search result dropdowns, current-location geolocation, outside-click dismissal, exact preview viewport sizing, and temporary wheel-zoom feedback.
  - Splits expensive work into prepared viewport data, compiled base assets, and visible pattern derivation.
  - Line/marker legend toggles now filter cached overlays; fill toggles recompile cells only.
- `src/core/pattern/curateFeatures.ts`
  - Main stitch-aware filtering / simplification pass.
  - Contains polygon filtering, marker budgeting, line thinning, snapped road graph logic, and parallel-corridor collapse.
- `src/core/pattern/compilePattern.ts`
  - Compiles curated features into pattern cells / backstitch / markers.
  - Polygon fill compilation now operates in projected grid space with a cell-local polygon index.
  - Exposes split helpers for cells, overlays, and final document assembly.
  - Also contains backstitch path snapping + simplification.
  - Contains the conservative 3/4-stitch eligibility pass for polygon fills.
  - Backstitch smoothing is no longer user-configurable; the previous balanced behavior is now the fixed behavior.
  - The old compile-time single-component road backstitch prune was removed.
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
- `src/render/exporters.ts`
  - Creates PNG downloads from the rendered canvas.
  - Can composite a device-pixel-ratio-aware attribution footer beneath the exported image.
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
- Route-centerline extraction and the old graph-growth selector were removed because source-zoom roads are now the only active road selection path.
- All remaining road-like candidates are selected after parallel-corridor collapse; there is no final single-component road prune.
- Selected road geometry is still endpoint-snapped before compilation.
- Compile-time Douglas-Peucker simplification remains enabled for roads so long diagonals do not become blocky staircases.

## Continuous rail, ferry, and stream approach

- Railways, ferry routes, and streams are now treated as atomic continuous-line candidates during curation.
- A candidate is either kept whole or discarded as a near-complete duplicate; the generic segment-by-segment thinning pass can no longer punch gaps through its interior.
- Rail, ferry, and stream occupancy are tracked separately, so a nearby road cannot accidentally suppress any of these networks.
- After whole-candidate selection, near-touching endpoints snap to another selected line of the same kind. Rail and ferry routes use a 2-cell radius; streams use a 1.5-cell radius.
- Endpoints on the viewport edge are left in place so offscreen continuations are not pulled inward.
- Stream runs are still clipped where they cross rendered water polygons before continuity selection.
- Parallel railway collapse still happens before this pass.

## What looks better now

- Seattle hosted preset is much less cluttered than the initial raw-vector version.
- Coastlines / fill boundaries can now be softened with conservative 3/4 stitches instead of quarter-stitch fringe.
- The stitched preview reads more like a finished physical product through fabric texture,
  dimensional floss, softer cross-stitch shadows, and restrained stitch irregularity.
- Switching between chart and stitched modes no longer changes the preview dimensions.
- The visible preview viewport now matches the configured pattern dimensions exactly, with a diagonal-bar panel around it.
- Multi-lane overlap is reduced compared with the early raw-vector passes.
- Road detail now changes the source zoom for road-like layers instead of expanding a manually curated graph budget.
- Sidewalk-like paths are more aggressively suppressed when they shadow stronger roads.
- Source-zoom road rendering keeps disconnected tile-selected road pieces instead of pruning to one component.
- Backstitch diagonals look cleaner after the compile-time line simplification pass.
- Railways, ferry routes, and streams no longer lose arbitrary interior segments to overlap thinning, and small same-network endpoint misses are repaired before rendering.
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
- Search results appear as a dropdown, close on outside click, and disappear after selecting a result.
- Copying the browser URL now preserves the viewed location and active pattern/legend settings without adding a separate sharing workflow.
- The search/location controls and preview remain contained at mobile viewport widths instead of creating page-level horizontal overflow.

## What still looks rough

- 3/4 stitch smoothing is intentionally conservative and may still leave some edges fully stepped where a human designer might choose a fractional stitch.
- Major freeway-style corridors are still heuristic, not fully topological.
- Parallel-way collapse is proximity/grid-overlap based, not a true medial-axis or corridor-spine algorithm.
- Connectivity is measured after rasterization into stitch-grid cells. A road can be geographically connected but miss by a cell, which is why endpoint snapping and the interstate bridge radius still exist.
- High road detail can still be heavier because source tiles expose many more road fragments, though the parallel-corridor matcher now uses a spatial index and cached rasterization.
- There is no dedicated diagnostics UI yet for why a specific road survived, collapsed, or was excluded.
- The workspace intro copy still says “Use the grouped legend below…” even though the explicit subgroup headings were removed. That copy is functionally fine but could be tightened.
- The slippy map still works on a stitch-grid abstraction, not true continuous cartographic rendering, so motion can feel a little approximate when rerenders are fast/slow.
- Wheel zoom has temporary canvas feedback and an idle commit path, but it is still a custom interaction that should be tested across mouse wheels and trackpads.
- Current-location centering depends on browser geolocation permission and a secure context outside local development.
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
5. If road clutter returns, consider a nuanced multi-component road filter rather than restoring the old single-component prune.
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
- The old road `roadNetworkMode` option, graph-growth budget selector, route-centerline special cases, and compile-time disconnected-road prune were removed in the cleanup pass.
- `continuousLineKind(...)` covers `rail`, `ferry`, and `stream`; these kinds bypass `thinLineCandidate(...)` and use whole-candidate duplicate rejection plus same-kind endpoint snapping.

## Last validated state

- In-browser target: `http://127.0.0.1:5173/`
- Last manually checked state:
  - OpenFreeMap Seattle waterfront default
  - stitch detail hidden in the UI and defaulted to high
  - preview mode: chart and stitched
  - both preview modes use the same canvas and exact clipped viewport dimensions
  - preview panel has diagonal bars around the exact clipped pattern viewport
  - wheel zoom prevents page scroll over the preview, gives temporary scale feedback, commits on idle or threshold, and clamps feedback at the real min/max zoom
  - initial source zoom is 11; browser testing confirmed zooming out below the previous floor by reaching z9
  - stitched mode uses the realistic woven-fabric/floss treatment
  - conservative 3/4 stitches appear only where neighboring cells corroborate the smoothed edge
  - legend order: fills, then ways, then POIs
  - legend cards are compact and show DMC floss codes
  - extra vertical space sits below the legend rather than inflating the preview frame
  - render interactions were re-checked after the performance pass
  - road-detail slider defaults to `Medium`
  - boundaries are absent and streams are omitted over water fills
  - rail, ferry, and stream candidates are retained whole and snap near-touching same-kind endpoints
  - live OpenFreeMap data around the Seattle ferry terminal produced a `Ferry Route` legend entry using dark navy `DMC 336`; 19 curated ferry segments rendered across the water after selecting the terminal search result
  - the ferry legend toggle hides and restores ferry backstitch correctly, with no browser warnings or errors
  - route-centerline extraction has been removed from the active road pipeline
  - parallel-corridor collapse keeps anchor geometry and preserves rendered connector stubs
  - PNG export includes the OpenFreeMap/OpenMapTiles/OpenStreetMap attribution footer
  - `Current location` appears beside Search and preserves the active zoom when recentering
  - query-string state was observed updating during live map inspection, including a non-default center and z15 zoom
  - the sidebar footer links to `https://github.com/davisagli/openstitchmap`
  - at a 390px viewport, the document stays 390px wide and the oversized preview scrolls within its frame
- Build status:
  - `npm run build` passed
- `git diff --check` passed after the ferry route implementation.

## Recent commits

- `1e3669e` - `Prepare project for open source release`
- `b78ad08` - `Improve map navigation and export attribution`
- `1804f61` - `Clean up road pipeline and preview UI`
- `2bdaab4` - `Use source zoom for road detail`
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
