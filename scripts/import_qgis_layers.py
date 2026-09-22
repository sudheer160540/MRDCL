"""Create read-only web-map copies of the layers referenced by J:\589q.qgz.

The source QGIS project and shapefiles are only read. This keeps the portal
independent from the desktop project while preserving its supplied layers.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import geopandas as gpd

APP_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = APP_ROOT / "data" / "map-layers.json"
HOUSEHOLDS = APP_ROOT / "data" / "households.geojson"
LAYERS = [
    ("musi_buffer", "Musi River buffer", Path(r"J:\MUSI_BUFFER\MUSI_BUFFER.shp")),
    ("river", "River", Path(r"E:\thesis\thesis\State_Water_Resources_shapefiles\56_River.shp")),
    ("circles", "GHMC circles", Path(r"E:\thesis\thesis\hyd_B\NEW_BOUNDARIES\60_CIRCLES.shp")),
    ("wards", "GHMC wards", Path(r"E:\thesis\thesis\hyd_B\NEW_BOUNDARIES\300-WARDS.shp")),
    ("zones", "GHMC zones", Path(r"E:\thesis\thesis\hyd_B\NEW_BOUNDARIES\12-ZONES.shp")),
]


def clean(value):
    if value is None or (isinstance(value, float) and value != value):
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def clean_coords(value):
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], (int, float)):
            return [round(value[0], 7), round(value[1], 7)]
        return [clean_coords(item) for item in value]
    return value


def read_layer(layer_id, label, source):
    if not source.exists():
        raise SystemExit(f"Referenced QGIS source is unavailable: {source}")
    gdf = gpd.read_file(source)
    if gdf.crs is None:
        raise SystemExit(f"Layer has no coordinate system: {source}")
    # Simplify in Web Mercator by two metres to retain the official boundary
    # shape while keeping phones responsive.
    web = gdf.to_crs(3857)
    # Keep the complete official GHMC boundary layers so the desktop map has
    # the full city context. Rivers are clipped to the Phase 1 vicinity: the
    # source river dataset is statewide and would make a phone download slow.
    if layer_id == "river":
        web = web[web.geometry.intersects(SURVEY_CONTEXT)]
    web["geometry"] = web.geometry.simplify(2, preserve_topology=True)
    gdf = web.to_crs(4326)
    features = []
    for sequence, (_, row) in enumerate(gdf.iterrows(), start=1):
        properties = {key: clean(value) for key, value in row.drop(labels="geometry").items()}
        features.append({
            "type": "Feature",
            "id": f"{layer_id}-{sequence}",
            "properties": properties,
            "geometry": {"type": row.geometry.geom_type, "coordinates": clean_coords(row.geometry.__geo_interface__["coordinates"])},
        })
    return {"id": layer_id, "name": label, "source": str(source), "feature_count": len(features), "features": features}


def main():
    global SURVEY_CONTEXT
    if not HOUSEHOLDS.exists():
        raise SystemExit(f"Missing web household copy: {HOUSEHOLDS}")
    households = gpd.read_file(HOUSEHOLDS)
    if households.crs is None:
        raise SystemExit(f"Household web copy has no coordinate system: {HOUSEHOLDS}")
    SURVEY_CONTEXT = households.to_crs(3857).geometry.union_all().convex_hull.buffer(5000)
    collection = {"project": r"J:\589q.qgz", "note": "Read-only web copies of layers referenced by the supplied QGIS project.", "layers": [read_layer(*layer) for layer in LAYERS]}
    OUTPUT.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Created {OUTPUT} with " + ", ".join(f"{layer['name']}: {layer['feature_count']}" for layer in collection["layers"]))


if __name__ == "__main__":
    main()
