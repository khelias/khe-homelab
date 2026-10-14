# House 3D test fixture

A small made-up house in the shape of the real model (khe-meta `house/house-model.md`), for
`tests/house3d/`. Nothing here describes a real place: the names are invented, the device
entity ids start with `test_`, and the georeference points nowhere. Every device, car and
surroundings coordinate has three odd decimals, so the fixture's own privacy scan cannot match
numbers in the vendored three.js.

This file has a `devices` key, so the privacy scan flags it: scan the engine with the real
model, never this file.

```json house3d:geometry
{
 "units": "m",
 "axes": "x east along the street, z away from the street, y up",
 "georef": { "crs": "EPSG:3301", "origin_E": 135797.137, "origin_N": 197531.371, "x_axis_bearing_deg": 30, "fit_rms_m": 0.05 },
 "ceiling": 2.6,
 "roofs": {
  "roofN": { "pitch_deg": 6, "high_x": 2, "high_y": 4.6, "falls": "east", "outline": [[1.7, 6], [12.3, 6], [12.3, 10.3], [1.7, 10.3]], "thick": 0.3 },
  "roofS": { "slope": 0.1, "high_x": 2, "high_y": 4.0, "falls": "east", "outline": [[1.7, 1.7], [12.3, 1.7], [12.3, 6], [1.7, 6]], "thick": 0.3 }
 },
 "roof_steps": [
  { "a": [2, 6], "b": [12, 6], "top": "roofN", "bot": "roofS" }
 ],
 "walls": [
  { "a": [2, 2], "b": [12, 2], "t": 0.4, "top": "roofS", "openings": [
   { "kind": "window", "c": 2, "w": 1.2, "h": 1.2, "sill": 0.9 },
   { "kind": "glassdoor", "c": 5, "w": 2, "h": 2.2 },
   { "kind": "door", "c": 8.5, "w": 1, "h": 2.1 }
  ] },
  { "a": [12, 2], "b": [12, 6], "t": 0.4, "top": "roofS" },
  { "a": [12, 6], "b": [12, 10], "t": 0.4, "top": "roofN", "openings": [
   { "kind": "window", "c": 2, "w": 1, "h": 1.2, "sill": 0.9 }
  ] },
  { "a": [12, 10], "b": [2, 10], "t": 0.4, "top": "roofN", "openings": [
   { "kind": "window", "c": 3, "w": 2, "h": 2.2, "sill": 0 }
  ] },
  { "a": [2, 10], "b": [2, 6], "t": 0.4, "top": "roofN" },
  { "a": [2, 6], "b": [2, 2], "t": 0.4, "top": "roofS" },
  { "a": [7, 2.2], "b": [7, 9.8], "t": 0.15, "top": 2.6, "openings": [
   { "kind": "door", "c": 3.8, "w": 0.9, "h": 2.1 }
  ] }
 ],
 "furniture": [
  { "what": "sofa", "rect": [3, 3, 5, 4], "y": [0, 0.8] },
  { "what": "table", "circle": [10, 8, 0.6], "y": [0, 0.75] }
 ],
 "site": {
  "lot": [[0, -6], [20, -6], [20, 14], [0, 14]],
  "hedges": [[[0, 14], [20, 14]]],
  "fences": [[[0, -6], [13.5, -6]], [[17.5, -6], [20, -6]], [[20, -6], [20, 14]], [[0, -6], [0, 14]]],
  "gates": [
   { "name": "drive", "a": [13.5, -6], "b": [17.5, -6], "kind": "sliding", "slide": "a", "height": 1.5 }
  ],
  "decks": [[[2, 10.3], [8, 10.3], [8, 12.5], [2, 12.5]]],
  "paving": [[12.8, -6, 17.2, 1]],
  "porch": [8, 0.8, 9.5, 2],
  "garage_roof": { "rects": [[12.8, 0.8, 17.2, 7.2], [12.8, 7.2, 14, 9]], "y": [2.6, 2.8] },
  "pergola": { "rect": [8.5, 10.3, 11.5, 13], "height": 2.6, "modules": 2 },
  "outdoor_units": [{ "what": "heat pump", "rect": [12.4, 8, 12.9, 9], "y": [0, 0.8] }],
  "trees": [
   { "id": "t1", "kind": "apple", "pos": [3.5, -3], "height": 4, "crown": 3 },
   { "id": "t2", "kind": "birch", "pos": [18, 12], "height": 12, "crown": 5 }
  ]
 }
}
```

```json house3d:rooms
{
 "rooms": [
  { "id": "r1", "no": "01", "name": "Elutuba", "rects": [[2.2, 2.2, 7, 9.8]] },
  { "id": "r2", "no": "02", "name": "Magamistuba", "rects": [[7, 2.2, 11.8, 9.8]] },
  { "id": "carport", "no": "03", "name": "Varjualune", "rects": [[13, 1, 17, 7]] }
 ]
}
```

```json house3d:private
{
 "room_names": { "r1": "Testmari tuba", "r2": "Testjüri tuba" },
 "devices": [
  { "entity": "light.test_living", "name": "Testvalgusti", "type": "light", "room": "r1", "pos": [4.137, 2.317, 5.137] },
  { "entity": "sensor.test_bedroom_temp", "name": "Testtermomeeter", "type": "sensor", "room": "r2", "pos": [9.137, 1.313, 7.913] },
  { "entity": "camera.test_gate", "name": "Testkaamera", "type": "camera", "room": "oues", "pos": [1.137, 2.513, -5.331], "look": [0.717, 0.719] }
 ],
 "car": {
  "entity": "device_tracker.test_car",
  "name": "Testauto",
  "room": "carport",
  "path": [[15.137, -9.137], [15.137, -1.137], [15.137, 3.937]],
  "profile": {
   "length": 4.5, "width": 1.8, "height": 1.5,
   "side": [[-2.197, 0.311], [2.193, 0.311], [2.193, 0.791], [1.137, 0.913], [0.317, 1.393], [-1.337, 1.393], [-2.137, 0.951]],
   "glass": [[0.177, 0.953], [-1.313, 0.953], [-1.313, 1.337], [0.177, 1.337]],
   "wheels": { "r": 0.331, "x": [-1.397, 1.393], "track": 1.537 },
   "lights": {
    "front": [[[2.193, 0.713, -0.717], [2.193, 0.713, -0.371]], [[2.193, 0.713, 0.371], [2.193, 0.713, 0.717]]],
    "rear": [[[-2.197, 0.911, -0.717], [-2.197, 0.911, -0.371]], [[-2.197, 0.911, 0.371], [-2.197, 0.911, 0.717]]]
   }
  }
 }
}
```

```json house3d:showcase
{
 "showcase": {
  "title": "Testmaja",
  "intro": "Väljamõeldud maja testide jaoks.",
  "rooms": { "r1": { "text": "Elutuba lõunaaknaga.", "photos": [] } },
  "features": [
   { "id": "deck", "name": "Terrass", "icon": "info", "pos": [5, 0.3, 11.4], "text": "Terrass maja taga." }
  ]
 }
}
```

```json house3d:surroundings
{
 "surroundings": {
  "source": "Test fixture, not ETAK, 2026-01-01",
  "buildings": [
   { "outline": [[25.137, -3.137], [31.137, -3.137], [31.137, 5.137], [25.137, 5.137]], "height": 6.5 }
  ],
  "roads": [
   { "outline": [[-5.137, -11.137], [35.137, -11.137], [35.137, -7.137], [-5.137, -7.137]] }
  ]
 }
}
```
