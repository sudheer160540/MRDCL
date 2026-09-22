"""Create a read-only web copy of the supplied 589Bifurcated building layer."""

from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import geopandas as gpd

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"J:\589Bifurcated\589\AS_589_old.shp")
OUTPUT = APP_ROOT / "data" / "bifurcated-buildings.geojson"


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


def main():
    if not SOURCE.exists():
        raise SystemExit(f"Source shapefile not found: {SOURCE}")
    layer = gpd.read_file(SOURCE)
    if layer.crs is None:
        raise SystemExit("The bifurcated source has no coordinate system.")
    layer = layer.to_crs(3857)
    layer["geometry"] = layer.geometry.simplify(0.35, preserve_topology=True)
    layer = layer.to_crs(4326)
    features = []
    for number, (_, row) in enumerate(layer.iterrows(), start=1):
        if row.geometry is None or row.geometry.is_empty:
            continue
        properties = {key: clean(value) for key, value in row.drop(labels="geometry").items()}
        features.append({
            "type": "Feature", "id": f"bifurcated-{number:04d}", "properties": properties,
            "geometry": {"type": row.geometry.geom_type, "coordinates": clean_coords(row.geometry.__geo_interface__["coordinates"])}
        })
    OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "name": "AS 589 bifurcated building layer", "features": features}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Created {OUTPUT} with {len(features)} read-only building features.")


if __name__ == "__main__":
    main()
