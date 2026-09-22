"""Create a web map copy of the MRDCL household shapefile.

This script only reads the source shapefile. It writes a separate GeoJSON file
inside this application so the original GIS files remain untouched.
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime
from pathlib import Path

import geopandas as gpd

APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("MRDCL_SOURCE_SHP", r"J:\589\589\AS_589_old.shp"))
OUTPUT = APP_ROOT / "data" / "households.geojson"


def clean(value):
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


def clean_coords(value):
    if isinstance(value, (list, tuple)):
        if value and isinstance(value[0], (int, float)):
            # Web maps need longitude/latitude; remove elevation and trim noise.
            return [round(value[0], 7), round(value[1], 7)]
        return [clean_coords(item) for item in value]
    return value


def main():
    if not SOURCE.exists():
        raise SystemExit(f"Source shapefile not found: {SOURCE}")

    gdf = gpd.read_file(SOURCE)
    if gdf.crs is None:
        raise SystemExit("The source shapefile has no coordinate reference system.")

    # Simplify in metre-based source CRS before projecting to WGS 84 for a fast browser map.
    gdf["geometry"] = gdf.geometry.simplify(0.35, preserve_topology=True)
    gdf = gdf.to_crs(4326)

    features = []
    for sequence, (_, row) in enumerate(gdf.iterrows(), start=1):
        properties = {key: clean(value) for key, value in row.drop(labels="geometry").items()}
        # OBJECTID, fid_1, S_Number and BuildingID contain duplicate values in the
        # supplied source. A stable import-row key prevents one polygon overwriting
        # another; the original identifiers remain available in the questionnaire.
        properties["household_id"] = f"AS589-{sequence:03d}"
        features.append(
            {
                "type": "Feature",
                "id": properties["household_id"],
                "properties": properties,
                "geometry": {
                    "type": row.geometry.geom_type,
                    "coordinates": clean_coords(row.geometry.__geo_interface__["coordinates"]),
                },
            }
        )

    collection = {
        "type": "FeatureCollection",
        "name": "MRDCL household survey baseline",
        "crs_note": "Source EPSG:32644 reprojected to EPSG:4326; geometry simplified for web display.",
        "features": features,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(collection, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Created {OUTPUT} with {len(features)} household polygons. Source was read only: {SOURCE}")


if __name__ == "__main__":
    main()
