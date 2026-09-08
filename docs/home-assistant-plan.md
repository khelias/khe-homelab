# Home Assistant rollout plan

Status: planned, nothing deployed yet (2026-09-08).

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
| Hikvision NVR/cameras | separate L2 subnet | no credentials, out of scope |

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

`configuration.yaml` is deliberately minimal - `default_config`, the `http`
proxy block, and `recorder: purge_keep_days: 30`. Location, name and units are
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

Deliberately not on the Cloudflare Tunnel.

## Phase 3 - Komfovent, read-only

Native `modbus:` YAML platform, not a HACS integration. The register map is
already measured, and a custom component is a dependency Renovate cannot track.

Entities worth having first: supply 901, extract 902, outdoor 903, filter %
916, power W 920, efficiency % 923, total kWh 930/931 (uint32, scale 0.001).

Two traps, both already paid for once:

- **Read uint32 pairs aligned.** A single-register read of one half returns
  Modbus exception 3, which makes a real register look absent.
- Flow control register 11 = 3 (OFF), so the "flow" fields are fan
  **percentages** and registers 905-908 (m3/h) are meaningless. Do not create
  airflow sensors from them.

Read-only for at least a week. Write access (mode, setpoints) comes after the
readings have proven stable, and the current settings are deliberate: extract
temperature control plus 60/60 % Normal fans, which took the electric
afterheater to zero. Do not let an automation revert that.

## Phase 4 - Daikin, read-only

The stock `daikin` integration does not speak this unit. The path is the
`daikin_altherma` custom integration over `ws://192.168.0.248/mca`, which means
installing HACS into the config volume. That is the first dependency outside
Renovate's reach, hence it comes after Komfovent rather than with it.

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
history to check afterwards whether it worked. Which leads to:

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

## Backup

Not wired up yet, and it needs a code change first: `tar_via_alpine()` in
`backup.sh` takes no exclude argument, and tarring a live SQLite recorder DB
produces an archive that may not restore. Either extend the helper or dump the
DB with `sqlite3 .backup` before the tar.

`.storage` holds the user database, tokens and integration credentials, so it
belongs in the encrypted offsite set and never in the repo.

## Docs to update when this lands

Same commit as the change, per the update discipline:

- `README.md` services table plus architecture diagram, and the new
  `services/home/` group in the layout.
- `ROADMAP.md` - remove Home Assistant from the weekend-projects wishlist.
- `docs/operational-notes.md` - the Modbus uint32 pairing trap, the NPM
  WebSocket toggle, `trusted_proxies`, the broken Daikin heating meter.
- `infrastructure/network/README.md` - `home.khe.ee` under LAN-only services.
- `SECURITY.md` - once HA can write to the ventilation or heat pump, the blast
  radius of this host changes and the security model has to say so.
