# MRDCL Household Survey Portal

This is a self-contained shared survey register for the 589 AS 589 household/building polygons. It is designed so both field teams work in one database instead of merging separate shapefiles. Authorities can sign in with a view-only role to see live progress and records.

## What is included

- Interactive supplied building/household polygons, reprojected to web-map coordinates from the supplied AS_589_old shapefile. The Phase 1 building layer is the only map background; it does not depend on street-map tiles or internet access.
- Search by household ID, owner/representative, contact, plot, or colony; filter by team and survey status.
- Structured questionnaire fields based on the source attribute table, with workflow, verification and field-note fields added for shared working.
- Complete Census Survey Questionnaire sections, including land, structures, vulnerability, resettlement, gender, cultural heritage and household member information.
- Downloadable administrator/authority exports: GIS GeoJSON, KML, Excel workbook, Word document, and CSV.
- Read-only local QGIS context layers: Musi River buffer, nearby rivers, and the complete GHMC zone, circle and ward boundaries, with a map-layer switcher.
- Administrator, Editor, and Authority (view-only) accounts.
- Concurrent-edit protection: a save is rejected if another team member has updated the same household first; the portal then loads the latest version.
- Audit log of recent changes, including who updated which household and which fields changed.
- SQLite database in `database/mrdcl-surveys.db`, using write-ahead logging for safe simultaneous use through this one server.

## Run it locally

Requirements already available on the preparation machine are Node.js 22+ and Python with GeoPandas. No Node packages need to be installed.

1. Open PowerShell in this folder.
2. Before its *first* start, set unique passwords (recommended):

   ```powershell
   $env:ADMIN_PASSWORD = 'use-a-long-unique-password'
   $env:TEAM1_PASSWORD = 'use-a-long-unique-password'
   $env:TEAM2_PASSWORD = 'use-a-long-unique-password'
   $env:AUTHORITY_PASSWORD = 'use-a-long-unique-password'
   npm start
   ```

   If no password variables are set on the very first start, the demonstration accounts are `admin` / `ChangeMe!589`, `team1` / `Team1!589`, `team2` / `Team2!589`, and `authority` / `ViewOnly!589`. Change these before making the service available to others. Password variables only seed a new database; they do not alter accounts that already exist.

   To replace an already-created account password from the trusted portal server, run this command (choose your own password):

   ```powershell
   $env:MRDCL_NEW_PASSWORD = 'use-a-long-unique-password'
   npm run reset:password -- admin
   ```

3. Browse to `http://localhost:5890`.

### Use from other office computers and phones

The portal server already listens on the local network. On this PC, the current Wi-Fi address is `192.168.0.206`, so colleagues on the same approved office Wi-Fi/LAN can open this address in Chrome:

```
http://192.168.0.206:5890
```

Windows must allow the inbound port once. Open PowerShell **as Administrator** on the portal host and run:

```powershell
cd 'J:\test website'
.\scripts\enable_lan_access.ps1
```

The script permits TCP port 5890 only from `192.168.0.0/24` (the current office Wi-Fi range). Each user signs in with their own account; all changes are saved to the same database immediately. The interface is responsive for Android/iPhone browsers. After IT publishes the portal behind HTTPS, Chrome users can also choose **Install app** to add it to a phone home screen.

On a phone, the map opens first. Tap the left **☰** button to open or close the Project Register. Tap a building polygon to open its survey; use **← Map** to close it, then the right **☰** Survey button to reopen the selected household. This keeps the map accessible at all times and avoids overlapping side panels.

The first server start creates `database/mrdcl-surveys.db`. This is the single shared working copy; back it up routinely while the server is stopped, or with SQLite-aware backup tooling.

## Make it available to both teams and authorities

Run this application once on an approved always-on MRDCL server or designated office PC—not once per team. Team members connect to that server's hostname and port on the internal network, for example `http://survey-server:5890`.

Ask the IT/network team to publish it behind HTTPS (a reverse proxy such as IIS, Nginx, or Caddy) and restrict access to the MRDCL network or VPN. Do not expose the unencrypted Node server or the SQLite file directly to the public internet. IT should also manage firewall access, TLS certificates, backups, and user-password policy.

Administrators can create additional editor or authority accounts from **Manage users** after signing in. The built-in roles are:

| Role | Access |
| --- | --- |
| Administrator | Create accounts, view and edit all records |
| Editor | View and update questionnaires |
| Authority | View map, dashboard, records and audit activity only |

## Data handling and updates

The original GIS files in `J:\589\589` are never changed. The web map uses the separate `data/households.geojson` copy, generated from that source with coordinates converted from EPSG:32644 to EPSG:4326 and geometry simplified only for faster browser display.

To rebuild that separate web map copy after receiving a newer source shapefile, stop the portal first and run:

```powershell
$env:MRDCL_SOURCE_SHP = 'J:\589\589\AS_589_old.shp'
npm run import:households
```

This reads the source only. It deliberately does not automatically replace the existing database because questionnaire edits must never be overwritten by an import. Take a backup and arrange a controlled migration if the baseline geometry itself changes.

The current QGIS project context (river, GHMC circles, wards and zones) has been copied into the separate browser map layer at `data/map-layers.json`. To regenerate that web-only copy after the QGIS sources are updated, run:

```powershell
npm run import:map-layers
```

This reads the corresponding layer files referenced by `J:\589q.qgz`; it never edits either the QGIS project or the source shapefiles.

## Important operational notes

- The map shows the supplied Phase 1 building polygons only. It intentionally has no third-party road, satellite, or OpenStreetMap background. When further phases arrive, import their source into a controlled new web-map copy and migrate it without overwriting questionnaire edits.
- Keep `database/mrdcl-surveys.db` private. It contains household survey information and must not be placed in a shared web folder.
- The questionnaire data and audit log are new application data. The source shapefile remains a read-only baseline.
"# MRDCL" 
"# MRDCL" 
