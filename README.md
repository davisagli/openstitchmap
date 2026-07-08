# OpenStitchMap

OpenStitchMap is an experimental tool for converting OpenStreetMap-style vector features into a cross stitch pattern.

## MVP status

This scaffold includes:

- A reusable pattern compiler that turns polygon, line, and point features into embroidery primitives.
- Two preview modes: a printable chart and a realistic stitched product preview.
- A live PMTiles-backed vector tile loader with on-screen layer diagnostics.
- Local demo data so the app still works without live tile access.
- JSON and PNG export actions.

## Next steps

- Add PMTiles and Mapbox/OpenMapTiles vector tile loaders.
- Add bounding box search and map selection.
- Expand palette reduction and DMC floss matching.
- Export printable PDFs with legends and page tiling.
- Support half stitches and richer POI symbols.
