# OpenStitchMap

OpenStitchMap is an experimental browser-based tool that turns real-world map
features into cross-stitch patterns. Choose a location, adjust the pattern and
road detail, then preview the result as either a printable chart or a stitched
piece.

## Features

- Search for a place or use your current location.
- Pan and zoom an interactive map-derived pattern preview.
- Set the pattern dimensions and calculate the finished size for common fabric
  counts.
- Adjust how much of the road network is included.
- Switch between symbol-chart and stitched-product previews.
- Hide individual fills, paths, and points of interest from the pattern using
  the interactive legend.
- Export the current preview as an attributed PNG.
- Inspect source-tile and pattern-curation diagnostics.

## Running locally

OpenStitchMap requires Node.js 20.19 or newer (or Node.js 22.12 or newer) and
npm.

```sh
npm install
npm run dev
```

Vite prints the local development URL when the server starts.

To create and preview a production build:

```sh
npm run build
npm run preview
```

The production files are written to `dist/`.

## How it works

The app loads OpenMapTiles-compatible vector tiles for the visible area and
normalizes their polygon, line, and point features. A curation pass simplifies
and prioritizes those features for the selected stitch grid. The pattern
compiler then converts areas to full or fractional cross stitches, roads and
other linear features to backstitch, and selected landmarks to symbols.

The chart and stitched previews are rendered in the browser with the Canvas
API. No project-specific backend is required.

## Project structure

- `src/app/` contains the React interface and interaction state.
- `src/core/tiles/` loads and decodes vector tiles.
- `src/core/pattern/` curates map features and compiles the stitch pattern.
- `src/render/` draws previews and exports PNG files.

## Map data and services

The live map source is provided by
[OpenFreeMap](https://openfreemap.org/) using the
[OpenMapTiles](https://www.openmaptiles.org/) schema and
[OpenStreetMap](https://www.openstreetmap.org/copyright) data. Place search uses
the public [Nominatim](https://nominatim.org/) service. Deployments must continue
to display the required attribution and comply with each provider's usage
policy.

## License

The OpenStitchMap source code is available under the [MIT License](LICENSE).
Map data and third-party services remain subject to their own licenses and
terms.
