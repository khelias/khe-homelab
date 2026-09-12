# Home Assistant rollout plan

Status: HA reachable at `home.khe.ee` from LAN and Tailscale, backup wired
(2026-09-12). Phases 3 and 4 both live via HACS since 2026-09-12 evening (Komfovent and
Daikin reading); observation week before any write.

Decisions taken up front:

- **HA Container under Docker Compose** on the existing Docker VM, not HAOS.
  Keeps the IaC model: pinned image, Renovate PRs, `backup.sh`, Kuma monitor,
  Homepage tile. Cost: no Supervisor, so no add-ons. Add-on equivalents run as
  ordinary containers in the same stack (Mosquitto, Zigbee2MQTT, ESPHome).
- **LAN + Tailscale only.** `home.khe.ee` via AdGuard rewrite and NPM. Not
  added to the Cloudflare Tunnel: Access breaks the HA companion app login and
  webhooks, and this host controls the house.
- **New service group `services/home/`.** HA is neither productivity nor core,
  and it will grow siblings (broker, Zigbee, ESPHome).

Device facts this plan builds on (measured, see the home-automation notes):

| Device | Address | Interface |
|---|---|---|
| Komfovent C6 | 192.168.0.155:502 | Modbus TCP, open, no controller-side enabling needed |
| Daikin Altherma 3 R | ws://192.168.0.248/mca | WebSocket, oneM2M JSON |
| Paradox alarm | 192.168.0.240 | no listening ports, out of scope |
| Hikvision NVR + 5 cameras | NVR 192.168.0.129, cameras .2/.41/.42/.44/.45 | ISAPI (Digest 401), RTSP 554, SDK 8000; passwords in hand since 2026-09-12 |

## Phase 0 - reachability (done 2026-09-08, partially)

Both protocols were re-verified, from the Mac rather than from the VM. That
substitutes here because Mac and VM share 192.168.0.0/24 on one L2 and
`harden-docker-vm.sh` sets `ufw default allow outgoing`; the only untested
difference is Docker's bridge NAT, which is standard behaviour.

- **Komfovent** registers 901-923 read in a single function-3 block:
  supply 21.0 C, extract 25.7 C, outdoor 19.5 C, reg 916 = 9, power 51 W.
  Register map still matches one-to-one. Reg 904 reads 0x8000, the
  sensor-absent marker, not a temperature.
- **Daikin** `ws://192.168.0.248/mca` returns 101 with a valid
  `Sec-WebSocket-Accept`.

Reading register-by-register still fails: the controller drops fast
consecutive connections, and single reads of a uint32 half return exception 3.
Read aligned blocks over one connection.

Still open, needs a shell on the VM (SSH is blocked by org policy for the
agent, so this is a manual step):

- `free -h` and `docker stats --no-stream` for the RAM budget. Rough asks:
  HA ~1.5G, Mosquitto ~128M, Zigbee2MQTT ~256M against a 32G VM.
- The NPM container's address on the `proxy` network, for `trusted_proxies`.
  The whole proxy subnet is an acceptable fallback if the exact address is
  inconvenient.

## Phase 1 - HA container up (done 2026-09-08)

`services/home/homeassistant/` now holds `docker-compose.yml` and
`config/configuration.yaml`. Pinned to `2026.9.1` by digest, current stable at
the time of writing. `./config:/config` bind mount (repo-tracked, like
Homepage), `proxy` network, host port 8123, 1536M / 1.0 CPU as a starting
limit, healthcheck via busybox `wget --spider` on `/manifest.json` with a
120s `start_period` because first boot is slow.

Also wired: `deploy.sh` and `deploy-stacks.sh` deploy order, `.gitignore`
whitelist for the config dir, port 8123 in `harden-docker-vm.sh`.

`configuration.yaml` is deliberately minimal - `default_config` and
`recorder: purge_keep_days: 30`. The `http` proxy block was there at first
and turned out to be dead: HA 2026.8 moved that to the UI (see the trusted
proxies note in operational-notes). A `modbus:` block and a YAML dashboard
existed for a few hours on 2026-09-12, see phase 3. Location, name and units are
left to the onboarding wizard so they land in `.storage`, which is gitignored;
this repo is public and the house's coordinates do not belong in it.

Deploy, then remaining manual steps:

- `sudo ufw allow from 192.168.0.0/24 to any port 8123` - `harden-docker-vm.sh`
  is not re-run on deploy.
- Onboarding wizard at `http://192.168.0.11:8123`.

## Phase 2 - access and observability (repo side done 2026-09-08)

Committed here:

- Homepage tile in a new `Kodu` group. No widget yet - the `homeassistant`
  widget needs a long-lived access token in the Homepage `.env`, which is a
  separate step and a credential this repo must never hold.
- `home.khe.ee` rewrite in `AdGuardHome.template.yaml`.

Manual, because these live in UIs whose credentials sit in VM `.env` files:

- **NPM proxy host** `home.khe.ee` -> `homeassistant:8123`, wildcard SSL, and
  **Websockets Support on**. Without it the frontend loads then hangs blank.
- **AdGuard live rewrite** via the UI (Filters -> DNS rewrites), not by editing
  `AdGuardHome.yaml`. Wholesale replacement wipes admin creds and sessions.
- **Uptime Kuma monitor** against `http://homeassistant:8123/manifest.json`
  (Kuma is on the `proxy` network, so the container name resolves), same
  Telegram notifier as every other service.

Checked 2026-09-12 from the LAN: `192.168.0.11:8123` answers and onboarding
is complete, but AdGuard does not resolve `home.khe.ee` while its siblings
resolve, and NPM has no host for it (TLS handshake fails where `photos.khe.ee`
returns 200). Later the same day: NPM host created via the API (answered 400 from HA
until trusted proxies were set in the UI, see operational-notes), AdGuard
rewrite added via the API, and `https://home.khe.ee` verified end to end from
the LAN. Along the way the router turned out to be handing out itself as DNS
with AdGuard nowhere in the path; DHCP DNS was set back to `192.168.0.11`
only, as the README describes. Still open: the Kuma monitor.

Deliberately not on the Cloudflare Tunnel.

## Where the earlier plan went

A 2026-08-30 session ("Home Assistant khe-homelabi seadistus") already worked
through this and reached different conclusions worth carrying over. Its phase
numbers do not match this document's; these are the substantive points.

**Hue was meant to be the first integration**, on the reasoning that the fastest
way to understand what HA is, is to add hardware whose behaviour you already
know, rather than debugging Modbus at the same time. **Checked 2026-09-08: no
Hue Bridge on the network** - scanned 192.168.0/24, 192.168.1/24 and
192.168.50/24 for both `/description.xml` and `/api/config`, nothing answered.
So the lamps are Bluetooth-only, bound to a phone, and HA cannot see them. A
Bridge (~60 EUR) would make Hue the single easiest integration in the house:
it is itself the Zigbee coordinator, speaks locally over LAN with no cloud, and
brings lamps, motion sensors, buttons and scenes in automatically. It would
also remove most of the reason for the USB coordinator in the Zigbee phase.

**Cameras were a whole phase and are missing from this document.** The shape
agreed then: the NVR stays the recorder, HA gets events and live view. Video
via RTSP straight from the cameras (sub stream `/Streaming/Channels/102`, not
main - five 4 MP main streams would melt the dashboard), events via ISAPI.
go2rtc is built into HA since 2024.11 and self-configures under
`default_config`, so WebRTC needs no extra container. Core `hikvision`
integration first (read events); `hikvision_next` from HACS only if automations
need to toggle detection. Frigate is a separate decision, gated on knowing how
many of the motion alerts are junk, and on the iGPU already being shared by
Jellyfin and Immich.

Re-checked 2026-09-12 with a port sweep from the LAN: the whole Hikvision set
is on 192.168.0.0/24 now, not on the orphaned .1 subnet, so the Docker VM
reaches it directly and no routing or alias work is needed. NVR at `.129`
(ISAPI answers Digest 401, RTSP 554, SDK 8000), five cameras at `.2`, `.41`,
`.42`, `.44`, `.45` with RTSP and SDK open and HTTP closed, one unidentified
`.153` with 8000 open. Hik-Connect is off, so nothing here has an internet
path, which is how it should stay. The user has the passwords.

Remaining blockers, both small: the NVR is inside the DHCP pool without a
reservation (router -> Manual Assignment, same page as the DNS fix), and the
integration may want an admin-level NVR account.

Integration choice: `hikvision_next` from the HACS default store rather than
the core `hikvision` platform. The core one is YAML-only and would put the
NVR password in a `secrets.yaml` on the VM; `hikvision_next` has a config
flow (host, port, user, password, RTSP port), keeps credentials in
`.storage`, and creates camera entities for main and sub streams plus event
binary sensors per channel from one NVR connection. Point it at the NVR, not
at the five cameras, so the NVR remains the single source of streams and
events. Live view goes through the built-in go2rtc, sub streams only.

**The honest framing from that session, still true:** HA is the most restless
service in this fleet - monthly releases, regular breaking changes - while
everything else here runs on Renovate and autoheal without asking for
attention. It pays for itself at the spot-price heating phase. If that is not
going to happen, the summer-standby problem is already solved by a calendar
reminder, and this stack is a hobby rather than infrastructure.

## Phase 3 - Komfovent via HACS (decided 2026-09-12)

**Decision reversed the same day it was implemented.** The native `modbus:`
route was built and verified (seven sensors, YAML dashboard, entities live in
HA), then dropped in favour of the HACS integration
[lnagel/hass-komfovent](https://github.com/lnagel/hass-komfovent). Reasons:

- Phase 4 needs HACS anyway (`daikin_altherma` has no native alternative), so
  "avoid the first out-of-Renovate dependency" stopped being a real saving.
- The integration gives a device model with modes and setpoints ready-made;
  with native modbus every write would be hand-mapped register by register.
- Preference stated plainly: maintained integrations over hand-rolled ones for
  a hobby service. HA moves monthly (the `http:` YAML block dying under us
  the same day was the live example); a maintained component moves with it.

Cost accepted: HACS plus two custom components live in `config/` outside
Renovate and autoheal. Keep that set to exactly HACS, `hass-komfovent`,
`daikin_altherma` until phase 6 works, and treat HA image bumps as manual
merges from now on, since a breaking change can arrive through a component CI
never sees.

**One poller at a time.** The C6 drops connections that arrive in quick
succession. The native `modbus:` config is removed in the same commit as this
text; deploy that and restart HA *before* adding the HACS integration, never
run both.

Install order, all manual (nothing here is repo-tracked):

1. HACS into the container:
   `docker exec homeassistant bash -c "wget -O - https://get.hacs.xyz | bash -"`,
   then `docker restart homeassistant`.
2. Settings -> Devices & services -> Add integration -> HACS (GitHub device
   auth).
3. HACS -> search "Komfovent" -> download -> restart HA.
4. Add integration -> Komfovent -> `192.168.0.155`. Poll interval 30 s is fine.

What carries over from the native attempt, still true whichever client reads
the registers:

- Measured map: supply 901, extract 902, outdoor 903 (int16 x0.1 C), filter %
  916, power W 920, efficiency % 923, total kWh 930/931 (uint32 x0.001).
  Live 2026-09-12: 17.3 / 24.7 / 15.6 C, filter 11 %, 52 W, 3015.2 kWh.
  Register 923 read 0 and the integration confirmed why: heat exchanger 0 %,
  heat recovery 0 W, i.e. the unit is in bypass (outdoor 17 C, extract 25 C,
  summer free-cooling), so zero efficiency is the true state, not a bad
  register. Electric heater 0 % / 0 W confirms the deliberate settings hold.
  Fans are 50/50 %, not the 60/60 % the 2026-08-30 notes remembered.
- Lifetime counters the integration exposes, 2026-09-12: AHU 3015.2 kWh,
  electric heater 1298.8 kWh (43 % of everything the unit ever drew),
  recovered heat 30 040 kWh. **Heater energy is the KPI for the read-only
  week**: with the current settings it must not move. Note the value, check
  it in a week and again on the first cold days.
- The wall panel reports room temperature and humidity (23.3 C / 50 % in the
  utility room), a free indoor sensor for phase 6.
- Write surface is wide: `climate` setpoint, Power, ECO/AUTO mode, AQ
  electric heater and the ECO blocking switches are all one tap in the app.
  Disable them for the observation week rather than relying on discipline.
- **Read uint32 pairs aligned.** A single-register read of one half returns
  Modbus exception 3, which makes a real register look absent.
- Flow control register 11 = 3 (OFF), so the "flow" fields are fan
  **percentages** and registers 905-908 (m3/h) are meaningless. Do not create
  airflow sensors from them; if the integration exposes them, ignore them.
- Reg 904 reads 0x8000, the sensor-absent marker, not a temperature.

Read-only for at least a week, even though the integration hands over write
entities on day one. The current settings are deliberate: extract temperature
control plus matched Normal fans took the electric afterheater to zero. Do not
let an automation, or a stray tap in the app, revert that.

## Phase 4 - Daikin, read-only (installed 2026-09-12)

The stock `daikin` integration does not speak this unit. The path is the
`daikin_altherma` custom integration (tadasdanielius) over
`ws://192.168.0.248/mca`, via HACS. Chosen over `daikin_onecta` because it is
local: no Daikin account, no cloud, no daily request quota (Onecta users hit
"daily rate limit reached" at 60 s polling). Known weaknesses, accepted:
integration last touched 2024, `pyaltherma` 0.0.21 from 2023, issue #120
reports "No module named pyaltherma" on HA 2026.3.3 with no maintainer
answer, and the two 2026 forks are identical to upstream. On this install it
loaded cleanly on 2026.9.2. If it breaks under a later HA, plan B is Onecta
with polling off and a scheduled refresh every few hours.

What it created, unit EHVX08S18DA9W7, firmware ID9652/IDE7C4, area
Tehnoruum:

- **Space Heating**: Climate Control switch (was **off** = the manual standby
  from 2026-08-29, now visible), Operation Mode select (`heating`),
  Temperature Control number (2, the weather-curve shift), sensors indoor
  20.0 C, leaving water 31.0 C, outdoor 17.0 C, Unit State OK. Heating
  energy sensors read 0 - true in standby and also the broken channel, so
  they prove nothing either way.
- **Hot Water Tank**: water_heater on, target 55 C, current 30 C, month
  heating energy 41 kWh (the DHW channel is the trustworthy one).
- Sensor names carry a `$NULL` prefix (unrendered template in the
  integration), cosmetic.

Write surface again: Climate Control on/off, mode, curve shift and the tank
target are single taps. Disable them for the observation week.

Unit indices: `/[0]/MNAE/1/...` is space heating, `/2/...` is the DHW tank,
`0` is the gateway.

Known-bad data to exclude from any dashboard or automation: **space-heating
electricity consumption is broken on this unit** (COP 181 impossible; proven
against the meter, 5.42 kWh billed against 0 written). DHW consumption is
sound. Produced-heat figures are usable. Anything built on the heating
consumption channel will be wrong.

Also carried over: space heating is currently in `standby`, set manually on
2026-08-29. **It has to be switched back before the house cools**, and the real
fix is the weather curve's summer cut-out limit at installer level, not a
manual switch. Making this visible in HA is one of the reasons to do this at
all.

## Phase 5 - MQTT and Zigbee

Hardware is expected, so plan for it rather than retrofitting:

- Mosquitto container in the same stack, authenticated, no anonymous access.
- Zigbee2MQTT container.
- USB coordinator passed from Proxmox to the Docker VM, then bound in compose
  by `/dev/serial/by-id/...`, never by `/dev/ttyUSB0` (renumbers on reboot).
- Decide the coordinator model before purchase, and check current firmware and
  Z2M support at that moment.

## Phase 6 - the part that pays

Spot-price-aware heating. The house's own numbers say this is where the money
is: heating is ~70 % of the bill, January was ~444 EUR, and the earlier
"turn heating off in summer" theory was measured and disproven, saving ~0 EUR.
Shifting load to cheap hours is the remaining lever, with the night tariff
alone worth 1.59 c/kWh in grid fees before the exchange price.

Two control paths, in order of effort:

1. LAN `Operation/Power` on/standby on a price schedule. Crude, already proven
   to work, no hardware.
2. Official power-limitation inputs DI1-DI4, setting `[A.6.3.1]`, needs the
   EKRP1AHTA board. Modulating rather than binary.

Prerequisite either way: a Nord Pool price source in HA, and enough recorder
history to check afterwards whether it worked. The price source landed
2026-09-12: HA's built-in `nordpool` integration, area EE, EUR, via the UI.
Raw spot price, no VAT or grid fee; the automation layer adds those as a
rule. First day's spread was 0.02 to 0.23 EUR/kWh, which is the whole case
for this phase in one line.

Building blocks exist, decide after the observation week which price stack
to stand on: the built-in integration plus the community Nord Pool
blueprints (water heater into cheapest hours, 15-min aware, no HACS), or the
community `nordpool` custom integration plus `nordpool_diff` (curve-shift
signal that heats before a price rise) and `nordpool_planner`. Own code is
the safety envelope (indoor floor, outdoor cut-off, max pause, default on)
and the mapping to the Daikin entities, as a repo-tracked package. Which
leads to:

- `recorder` with `purge_keep_days` set and noisy entities excluded, or SQLite
  grows without bound.
- Long-term energy history has no home today: Loki is logs only and there is no
  Prometheus in the stack. HA's own Energy dashboard is the pragmatic answer
  for now; a Prometheus is a separate roadmap item already implied by the
  Immich metrics entry.

Method rule that this house has enforced three times: **compute the baseline
over every available period with the same method before attributing a change to
a cause.** Two points always make a line. Pull outdoor temperature history from
Open-Meteo alongside any energy conclusion.

## Backup (wired 2026-09-12)

`backup.sh` now copies the recorder DB through Python's `sqlite3` backup API
inside the container (consistent point-in-time copy, no `sqlite3` CLI needed)
to `homeassistant-recorder.db.gz`, and tars the config dir as
`homeassistant-config.tar.gz` with `home-assistant_v2.db*` and
`home-assistant.log*` excluded. `tar_via_alpine()` grew a pass-through for
extra tar arguments to make that possible. Not yet exercised on the VM; the
first cron run after deploy will show it.

`.storage` holds the user database, tokens and integration credentials, so it
belongs in the encrypted offsite set (it is, via `/srv/backups`) and never in
the repo.

## Docs to update when this lands

Same commit as the change, per the update discipline. README, ROADMAP,
network README and the operational notes were updated with phases 1-3;
SECURITY.md is still pending and becomes due with write access.

- `README.md` services table plus architecture diagram, and the new
  `services/home/` group in the layout.
- `ROADMAP.md` - remove Home Assistant from the weekend-projects wishlist.
- `docs/operational-notes.md` - the Modbus uint32 pairing trap, the NPM
  WebSocket toggle, `trusted_proxies`, the broken Daikin heating meter.
- `infrastructure/network/README.md` - `home.khe.ee` under LAN-only services.
- `SECURITY.md` - once HA can write to the ventilation or heat pump, the blast
  radius of this host changes and the security model has to say so.
