# House HVAC

Local control interfaces and measured behaviour of the house heating, hot
water and ventilation. Written as the integration spec for a future Home
Assistant deployment, which is not yet in `services/`.

Everything here was verified with real protocol exchanges against the live
devices on 2026-08-22, 08-24 and 08-29. Nothing is copied from a datasheet.

## Devices

| Device | Role | Local interface |
|---|---|---|
| Daikin Altherma 3 (`lan-altherma3`) | air-to-water heat pump, integrated 200 l DHW tank | `ws://192.168.0.248/mca`, oneM2M over WebSocket |
| Komfovent C6 | balanced ventilation with heat recovery | Modbus TCP `192.168.0.155:502` |
| 6x wired room thermostats | per-room water underfloor heating zones | none, they only switch manifold actuators |
| Electric sauna heater | ~9 kW resistive | none |

Space heating is **water-based underfloor heating** fed by the Altherma, at
~30 °C leaving water on a weather-dependent curve. There are no electric
heating mats. The room thermostats are not connected to the Daikin, which is
why the heat pump exposes no room target temperature.

## Daikin: oneM2M over WebSocket

The plain HTTP server on port 80 is a decoy: `GET /` returns 500 and `POST /`
returns a 404 page. The real interface is a WebSocket upgrade on `/mca`.

Request envelope:

```json
{"m2m:rqp": {"fr": "hoge", "rqi": "<uuid>", "op": 2, "to": "<path>"}}
```

`rsc: 2000` means OK, `rsc: 4004` means the path does not exist on this unit.
Responses arrive as `m2m:rsp.pc["m2m:cin"]`, where `con` is the value, `st` is
a monotonic content-instance counter and `ct` is the creation timestamp.

Unit indices: `/[0]/MNAE/0/` is the gateway, `/[0]/MNAE/1/` is the space
heating circuit, `/[0]/MNAE/2/` is the DHW tank.

Verified paths:

```
/[0]/MNAE/1/Operation/Power                     on | standby   (writable)
/[0]/MNAE/1/Operation/OperationMode             heating | cooling | auto
/[0]/MNAE/1/Operation/LeavingWaterTemperatureOffsetHeating   -10..+10, writable
/[0]/MNAE/1/Sensor/LeavingWaterTemperatureCurrent
/[0]/MNAE/1/Sensor/OutdoorTemperature
/[0]/MNAE/1/Sensor/IndoorTemperature            unused on this install, see below
/[0]/MNAE/1/Consumption                         DO NOT TRUST, see below
/[0]/MNAE/2/Operation/Power                     independent of unit 1
/[0]/MNAE/2/Operation/TargetTemperature         30..60 C
/[0]/MNAE/2/Operation/DomesticHotWaterTemperatureHeating   writable
/[0]/MNAE/2/Operation/Powerful                  capital P exists; lowercase 4004
/[0]/MNAE/2/Sensor/TankTemperature
/[0]/MNAE/2/Consumption                         trustworthy
```

Space heating `Power` is independent of DHW `Power`. Setting unit 1 to
`standby` stops space heating for the season while hot water keeps running.
This is the user-level summer shutdown.

### Consumption payload shape

`Consumption/la` returns a JSON **string** (parse twice) of the form
`{"Electrical":{"Heating":{"D":[...],"W":[...],"M":[...]}}}`.

- `D` is 24 entries: **12 two-hour buckets for yesterday, then 12 for today**.
  Future buckets are `null`.
- `W` is 14 daily entries. The last non-null entry is **today**, not
  yesterday. Verify against `D` before trusting any weekday alignment; an
  off-by-one day silently destroys weekly patterns.
- `M` is 24 monthly entries: previous year Jan-Dec, then this year Jan-Dec.
- **All values are whole kWh.** A `0` means "under about half a kWh", not
  "nothing". Do not build conclusions on zeros.

## Komfovent: Modbus TCP

Function 3, unit id 1. Register numbering matches the community map in
`borpin/ha_komfovent_config/komfovent.yaml` one-to-one.

```
r0        unit on/off
r10       temperature control source   0=supply 1=extract
r11       flow control                 3=off, so "flow" fields are percentages
r105-108  Normal mode supply/extract fan percentage (u32 pairs)
r109      Normal mode setpoint, x0.1 C
r901      supply air temperature, x0.1 C
r902      extract air temperature, x0.1 C   (reads ~3 K above room, see below)
r903      outdoor air temperature, x0.1 C
r916      filter clog percentage
r920      current power, W
r926/927  consumption today,  x0.001 kWh
r928/929  consumption month,  x0.001 kWh
r930/931  consumption total,  x0.001 kWh
r932/933  electric heater today
r934/935  electric heater month
r936/937  electric heater total
r942/943  recovered energy total
r610-645  fault log, 5 registers per entry: [code, year, ...]
```

Readable blocks: `0-43`, `99-134`, `200-209`, `300-459`, `500-959`. Mode
setpoint blocks have stride 6 from 99: Away 99, Normal 105, Intensive 111,
Boost 117, Kitchen 123.

**Gotcha:** a single-register read of one half of a `uint32` pair returns
Modbus exception 3. Probing address by address makes real registers look
absent. Read aligned pairs, or block-read and slice.

`r902` extract air reads about 3 K above what the room thermostats report,
because the sensor sits inside the unit and the unit shares a warm technical
room with the heat pump. **Use the room thermostats for room temperature, not
this register.** Treating extract air as room temperature produced a wrong
conclusion once already.

## Known-bad data

Two fields look authoritative and are not. Both must be excluded from any
Home Assistant energy dashboard, or the dashboard will lie.

### Space heating electricity is not counted

`/[0]/MNAE/1/Consumption` reports 0-14 kWh per month for space heating. This
is wrong by roughly a factor of 50. Cross-checks:

| Source | Value |
|---|---|
| Produced heat, January (controller graph) | ~2500 kWh |
| Compressor operating hours, space heating | 27 117 h |
| Backup heater operating hours, space heating | 22 h |
| Reported space heating electricity, January | 14 kWh |

2500 kWh of heat from 14 kWh of electricity would be COP 180. The compressor
did the work, not the backup heater, so this is not a backup-heater
accounting gap. The DHW pair is internally consistent (~67 kWh in, ~160 kWh
out, COP 2.4), so the metering framework itself works.

The unit has no physical electricity meter; the figure is calculated or read
from an external meter input. This is a commissioning gap, not damaged
hardware. Pending an installer visit.

**For Home Assistant: derive heat pump electricity from a clamp meter or a
dedicated circuit meter, not from the unit.** Produced heat and operating
hours can be trusted.

### IndoorTemperature is a placeholder

`/[0]/MNAE/1/Sensor/IndoorTemperature` returns a fixed `20.0` with `st=2`,
last written at the gateway boot. There is no room thermostat wired to the
Daikin on this install, and the unit exposes no room target temperature at
all, which is the tell. The field is unused, not faulty. Do not surface it.

## Timestamps and history

The gateway clock read `2000-01-01` until **2026-08-13 20:40 UTC**, when it
first got a working default gateway and NTP. Monthly consumption buckets
older than that date are dated by a wrong clock and are unreliable. Anything
from 2026-08-13 onward is sound.

`SyncStatus: "reboot"` in every `UnitProfile` is not an error state. Sensor
fields are written only when the value changes, so a long-idle machine looks
frozen. A real change propagates within seconds.

## Measured behaviour, August 2026

Baseline for comparison once Home Assistant starts collecting its own data.
Whole-house figures are from the DSO meter, 12-29 August 2026, 367 kWh total.

- Standing load with the house empty: **468 W**, of which Komfovent 58 W and
  an estimated 150-210 W heat pump.
- Komfovent: 87 W running, 42 kWh in August, electric heater **0 kWh** since
  the 2026-08-24 change from supply to extract temperature control. Before
  that change the heater was 44 % of the unit's lifetime energy.
- DHW: ~3 kWh/day, plus a **weekly anti-legionella cycle every Wednesday at
  02:00** drawing ~4.5 kWh in one hour via the DHW backup heater stage
  (117 h lifetime). That cycle is ~25 % of all DHW electricity.
- Space heating ran through August at 8-28 kWh of heat per day, with rooms
  already at 22-23.5 °C and outdoor at 22-24 °C. The weather curve has no
  effective summer cutoff. Unit 1 was set to `standby` on 2026-08-29 as the
  interim fix.
- Sauna: ~15 kWh per session, four sessions in twelve days.

## Billed baseline

Real invoices for this meter (EIC `38ZEE-00732642-B`, 20 A, package Vork 4)
under the **previous occupancy**, which ran lower room setpoints than we do
and had no sauna, homelab or family load. Treat these as a floor, not a
forecast.

| Month | kWh | Energy | Network | Total | EUR/kWh |
|---|---|---|---|---|---|
| Jul 2025 | 340.7 | 19.64 | 39.62 | **59.26** | 0.174 |
| Jan 2026 | 1608.8 | 328.10 | 115.53 | **443.63** | 0.276 |
| Feb 2026 | 1394.8 | 285.11 | 102.67 | **387.78** | 0.278 |
| Mar 2026 | 782.8 | 76.94 | 68.68 | **145.62** | 0.186 |

Meter readings on the invoices fill the gaps: 41 517.5 on 2025-07-31 and
46 316.8 on 2026-01-31, so Aug-Dec 2025 was 3 190 kWh, averaging 638
kWh/month. Full year lands near **8 600 kWh and about 2 000 EUR**.

January costs roughly three times March for two reasons that multiply, not
add: twice the volume, and an exchange price that was 22.1 vs 8.8 c/kWh in
the day tariff. Volume and price peak in the same month.

### Network tariff, for reconstructing any missing invoice

```
transmission day    0.0369 EUR/kWh
transmission night  0.0210 EUR/kWh
monthly fee         19.53 EUR (20 A, from 2026-01; 18.97 in 2025)
renewable levy      0.0084 EUR/kWh
supply security     0.00758 EUR/kWh   (new from 2026-01)
excise              0.0021 EUR/kWh
VAT                 24 % (22 % before 2026)
```

Reproduces the February 2026 network invoice to the cent.

### Summer heating was already being paid for

July 2025 was 340.7 kWh, or 11.0 kWh/day. The house measured 11.2 kWh/day in
August 2026 while **standing empty**. Same number. The previous occupancy was
paying the same standing load, including the same pointless summer space
heating documented above. At roughly 4.5 kWh/day over the warm half of the
year that is 400-600 kWh, or 80-140 EUR annually, recovered by a single
`standby` on unit 1.

## Open items

- Installer: configure space heating electricity metering.
- Installer or user menu: outdoor temperature cutoff for space heating, so the
  summer shutdown is automatic rather than a manual `standby`.
- Room thermostat clocks are all set to different wrong times, so any weekly
  schedules in them run at arbitrary hours. Living room setpoint was found at
  17.5 °C against 22.5 °C elsewhere.
- The Daikin gateway is still linked to the previous owner's Onecta account
  (`GATEWAY_DEVICE_ALREADY_LINKED`), so a third party retains cloud access.
  Local control is unaffected.

## Client notes

Neither `pymodbus` nor `websocket-client` is needed. Both protocols are
reachable with the standard library: raw socket Modbus TCP framing, and a
hand-rolled WebSocket handshake plus masked frames for `/mca`. Home Assistant
has a `modbus` platform for the Komfovent and the `daikin_altherma` custom
integration speaks this exact oneM2M dialect.
