#!/usr/bin/env python3
"""Generate and save the Home Assistant Overview dashboard for the house.

The dashboard is storage-mode config in HA's .storage (backed up nightly by
backup.sh); this script is its source of truth. Edit here, run, and HA picks
the new config up live. Layout and the reasoning behind it are described in
khe-meta's house/home-assistant-plan.md ("Dashboard"); that repo is private
because the plan names the house's devices and addresses.

Usage:  ha-dashboard.py            (saves to the "lovelace" Overview)
Needs:  python3 with `websockets`, the HA long-lived token in
        ~/.config/khe/ha-token, optional family list in ~/.config/khe/ha-people.json.
"""
import asyncio, json, os, websockets
HA = "192.168.0.11:8123"
TOKEN = open(os.path.expanduser("~/.config/khe/ha-token")).read().strip()
URL = "lovelace"  # the Overview, a dashboard entry since the 2026.9 migration
FORECAST = "sensor.elektri_hinna_prognoos"
DHW = "water_heater.hot_water_tank_domestic_hot_water_tank"
# This repo is public, so nothing that identifies the house or the family is hard-coded here.
# Two untracked local files carry that, and every consumer below degrades to "leave the card out"
# when they are missing:
#   ~/.config/khe/ha-house.json   {"cams": [[slug, label], ...], "phone": "sensor.<device>",
#                                  "nvr_app_url": "<scheme>://", "updates": ["update.<x>"]}
#   ~/.config/khe/ha-people.json  [[entity_id, label], ...]
# Presence badges render "<name> <state>", so the verb rides in the name ("X on" -> "X on Kodus").
def _local(name, default):
    path = os.path.expanduser("~/.config/khe/" + name)
    return json.load(open(path)) if os.path.exists(path) else default

_house = _local("ha-house.json", {})
CAMS = [tuple(c) for c in _house.get("cams", [])]
PHONE = _house.get("phone")
NVR_APP = _house.get("nvr_app_url")
PEOPLE = [tuple(p) for p in _local("ha-people.json", [])]
UPDATES = ["update.hacs_update", "update.komfovent_update", "update.daikin_altherma_update",
           "update.estfeed_update", "update.apexcharts_card_update",
           "update.advanced_camera_card_update"] + _house.get("updates", [])

def tile(entity, name=None, **kw):
    c = {"type": "tile", "entity": entity}
    if name: c["name"] = name
    c.update(kw); return c
def nowrite(entity, name, **kw):
    return tile(entity, name, tap_action={"action": "none"}, icon_tap_action={"action": "none"}, **kw)
def when_on(entity, name, **kw):
    return tile(entity, name, color="red", visibility=[{"condition": "state", "entity": entity, "state": "on"}], **kw)
def third(card):
    card["grid_options"] = {"columns": 4, "rows": 2}; return card
def flat(card):
    card["grid_options"] = {"columns": 4, "rows": 1}; return card
# A row of vertical tiles as grid cells rather than a horizontal-stack, which never wraps:
# five in a stack are 68 px each on a phone and every name truncates. A section is
# 12 columns on a phone and 12 per column it spans on a wide screen, so a cell of 4
# is three to a row on the phone and six in a wide section. Four go 2x2 instead of
# leaving one tile alone on the second line.
def row(cards):
    cols = {1: 12, 2: 6, 4: 6}.get(len(cards), 4)
    for c in cards: c["grid_options"] = {"columns": cols, "rows": 2}
    return cards
def hist(title, ents, hours):
    return {"type": "history-graph", "title": title, "hours_to_show": hours,
            "entities": [{"entity": e, **({"name": n} if n else {})} for e, n in ents]}
def section(title, cards, column_span=1, **heading):
    return {"type": "grid", "column_span": column_span, "cards": [{"type": "heading", "heading": title, **heading}] + cards}
def nav(path):
    return {"tap_action": {"action": "navigate", "navigation_path": path}}

# The "what should I do now" answer, above the curve. Two price bases on purpose:
# the level word is classified on the bare spot price (see energy_price.yaml), the
# windows are searched on the billed price, so the text names both numbers.
# The text is the point here, not a stand-in for the chart below it: one of the two
# adults does not read the curve. So it gets designed rather than shortened - the
# verdict as a coloured ha-alert (the colour follows the current hour's band, so a
# glance is enough), one icon per decision, tomorrow set off on its own line.
ALERT = ("{% set t = states('sensor.elektri_hinna_tase') %}"
         "{{ 'success' if t in ['väga odav', 'odav'] else 'info' if t in ['tavaline', 'kõrgevõitu']"
         " else 'warning' if t == 'kallis' else 'error' }}")
price_now = {"type": "markdown", "content": (
    f'<ha-alert alert-type="{ALERT}">'
    "{{ state_attr('sensor.elektri_hinna_tase', 'hinnang') }}. "
    "{{ state_attr('sensor.elektri_hinna_tase', 'tekst') }}</ha-alert>\n\n"
    '<ha-icon icon="mdi:washing-machine"></ha-icon> **Pesu 4 h:** '
    "{{ state_attr('sensor.odavaim_aken_pesu', 'tekst') }}\n\n"
    '<ha-icon icon="mdi:hot-tub"></ha-icon> **Saun 2 h:** '
    "{{ state_attr('sensor.odavaim_aken_saun', 'tekst') }}"
    "{% if has_value('sensor.homme_elekter') %}\n\n"
    '<ha-icon icon="mdi:weather-night"></ha-icon> '
    "{{ state_attr('sensor.homme_elekter', 'tekst') }}{% endif %}"),
    "grid_options": {"columns": "full"}}

price_chart = {
    "type": "custom:apexcharts-card", "graph_span": "2d", "span": {"start": "day"},
    "header": {"show": True, "title": "Hind täna ja homme, €/kWh", "show_states": False},
    "now": {"show": True, "label": "Praegu"},
    "yaxis": [{"min": 0, "decimals": 2}],
    "experimental": {"color_threshold": True},
    "apex_config": {"legend": {"show": True}, "plotOptions": {"bar": {"columnWidth": "90%"}},
                    "xaxis": {"labels": {"datetimeFormatter": {"hour": "HH:mm", "day": "ddd"}}}},
    "series": [
        {"entity": FORECAST, "name": "Kokku", "type": "column", "float_precision": 3,
         "show": {"extremas": True},
         "color_threshold": [{"value": 0, "color": "#43a047"}, {"value": 0.15, "color": "#fb8c00"}, {"value": 0.25, "color": "#e53935"}],
         "data_generator": "return entity.attributes.prices.map(p => [p.s * 1000, p.t]);"},
        {"entity": FORECAST, "name": "Börs", "type": "line", "curve": "stepline", "stroke_width": 1, "color": "#90a4ae", "float_precision": 3,
         "data_generator": "return entity.attributes.prices.map(p => [p.s * 1000, p.p]);"}]}

# Daikin exposes per-period arrays as attributes ("Last Monday".."Sunday", "Last January".."December");
# the integration's state is only the current bucket, so the charts read the attributes directly.
DAYS_JS = """
const a = entity.attributes, names = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const now = new Date(), dow = (now.getDay() + 6) % 7;
const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
const out = [];
for (let w = -1; w <= 0; w++) for (let i = 0; i < 7; i++) {
  const v = a[(w < 0 ? 'Last ' : '') + names[i]];
  if (v === undefined || v === '-') continue;
  const d = new Date(mon); d.setDate(mon.getDate() + w * 7 + i);
  out.push([d.getTime(), Number(v)]);
}
return out;
"""
MONTHS_JS = """
const a = entity.attributes, names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const y = new Date().getFullYear(), out = [];
for (let k = -1; k <= 0; k++) for (let i = 0; i < 12; i++) {
  const v = a[(k < 0 ? 'Last ' : '') + names[i]];
  if (v === undefined || v === '-') continue;
  out.push([new Date(y + k, i, 1).getTime(), Number(v)]);
}
return out;
"""
def daikin_bars(title, entity, span, end_unit, js, fmt):
    return {"type": "custom:apexcharts-card", "graph_span": span, "span": {"end": end_unit},
            "header": {"show": True, "title": title, "show_states": False},
            "yaxis": [{"min": 0, "decimals": 0}],
            "apex_config": {"legend": {"show": False}, "plotOptions": {"bar": {"columnWidth": "70%"}},
                            "xaxis": {"labels": {"datetimeFormatter": fmt}}},
            "series": [{"entity": entity, "name": "kWh", "type": "column", "color": "#42a5f5", "float_precision": 0,
                        "data_generator": js}]}


MODE = "select.komfovent_operation_mode"
def action_tile(entity, name, icon, color, perform_action, data, text, **kw):
    """Quick-mode tile: same size as the other tiles, state hidden, tap runs an action after a confirmation."""
    act = {"action": "perform-action", "perform_action": perform_action, "target": {"entity_id": entity},
           "data": data, "confirmation": {"text": text}}
    return tile(entity, name, icon=icon, color=color, hide_state=True, tap_action=act, icon_tap_action=act, **kw)
def mode_button(name, icon, option, color=None, **kw):
    return action_tile(MODE, name, icon, color, "select.select_option", {"option": option},
                       f"Ventilatsioon režiimile {name}?", **kw)

# The boost tile as two tiles, one per state. A tile colours its icon whenever the entity is
# active, and the tank's normal mode "on" counts as active, so a single tile sat orange all
# day as if boost were running. Grey while off; orange only in "performance", and there a
# tap ends it instead of asking to start it again.
def dhw_boost():
    def is_(mode, neg=False):
        return [{"condition": "state", "entity": DHW, ("state_not" if neg else "state"): mode}]
    return [action_tile(DHW, "Kiirsoojendus", "mdi:water-boiler", "disabled", "water_heater.set_operation_mode",
                        {"operation_mode": "performance"}, "Boileri kiirsoojendus (Daikin Powerful) sisse? Lõpeb ise, kui vesi on soe.",
                        visibility=is_("performance", neg=True)),
            action_tile(DHW, "Kiirsoojendus sees", "mdi:water-boiler", "orange", "water_heater.set_operation_mode",
                        {"operation_mode": "on"}, "Lõpetad boileri kiirsoojenduse? Vesi soojeneb edasi tavarežiimis.",
                        visibility=is_("performance"))]


def note(text):
    return {"type": "heading", "heading": text, "heading_style": "subtitle"}
def bars(title, ents, days, stat="change"):
    return {"type": "statistics-graph", "title": title, "chart_type": "bar", "period": "day", "days_to_show": days, "hide_legend": len(ents) == 1, "min_y_axis": 0,
            "stat_types": [stat], "entities": [{"entity": e, "name": n} for e, n in ents]}


def confirm(entity, name, text, **kw):
    """Tile whose tap and icon tap both toggle after a confirmation dialog."""
    act = {"action": "toggle", "confirmation": {"text": text}}
    return tile(entity, name, tap_action=act, icon_tap_action=act, **kw)

FAULTS = [("binary_sensor.suitsuandurid", "Tulekahju"),
          ("binary_sensor.space_heating_unit_state", "Soojuspumba viga"), ("binary_sensor.hot_water_tank_state", "Boileri viga"),
          ("binary_sensor.komfovent_status_alarm_fault", "Ventilatsiooni viga"), ("binary_sensor.komfovent_status_alarm_warning", "Ventilatsiooni hoiatus")]

# Two columns even on a wide screen: sections fill rows in order and are not packed, so with three
# only Küte sat beside the tall Elekter section and everything else went below it.
home = {"title": "Kodu", "path": "kodu", "icon": "mdi:home", "type": "sections", "max_columns": 2,
 "badges": [
    *[{"type": "entity", "entity": e, "name": n, "show_name": True, "show_state": True} for e, n in PEOPLE],
    # Arming on the way out is a daily action, so the state belongs here. Tap
    # opens more-info, which carries the arm buttons: no detour via the tab.
    {"type": "entity", "entity": "alarm_control_panel.maja", "name": "Maja", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "alarm_control_panel.garaaz", "name": "Garaaž", "show_name": True, "show_state": True},
 ] + [
    {"type": "entity", "entity": e, "name": n, "color": "red", "show_name": True, "show_state": False, "visibility": [{"condition": "state", "entity": e, "state": "on"}]}
    for e, n in FAULTS
 ],
 "sections": [
    section("Elekter", [
        price_now,
        price_chart,
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.maja_tana", "Täna", state_content=["state", "kulu"], vertical=True),
            nowrite("sensor.maja_eile", "Eile", state_content=["state", "kulu"], vertical=True),
            nowrite("sensor.maja_sel_kuul", "Sel kuul", state_content=["state", "kulu"], vertical=True)]},
        bars("Tarbimine 7 päeva, kWh", [("estfeed:estfeed_consumption_642b", "kWh")], 7),
        bars("Kulu 7 päeva, €", [("estfeed:estfeed_cost_642b", "€")], 7),
    ], column_span=2,
       badges=[{"type": "entity", "entity": "binary_sensor.nord_pool_ee_homne_hind_on_saadaval", "name": "Homne hind olemas", "state_content": "name",
                "visibility": [{"condition": "state", "entity": "binary_sensor.nord_pool_ee_homne_hind_on_saadaval", "state": "on"}]},
               {"type": "entity", "entity": "binary_sensor.maja_andmed_varsked", "name": "Estfeedi andmed hilinevad", "state_content": "name", "color": "red",
                "visibility": [{"condition": "state", "entity": "binary_sensor.maja_andmed_varsked", "state": "off"}]}],
       **nav("/lovelace/energia")),
    section("Küte", [
        nowrite("switch.space_heating_climate_control", "Küte (Daikin)"),
        tile("sensor.space_heating_leaving_water_temperature", "Küttevee temp"),
        when_on("binary_sensor.space_heating_unit_state", "Soojuspumba viga"),
    ], **nav("/lovelace/soojuspump")),
    section("Soe vesi", [
        nowrite(DHW, "Boiler", state_content=["state", "current_temperature"]),
        # Daikin Powerful: the one DHW quick mode on Kodu. Temporary, the unit returns to normal
        # by itself once the tank is hot, so an accidental tap costs one heat-up, not a setting.
        *dhw_boost(),
        when_on("binary_sensor.hot_water_tank_state", "Boileri viga"),
    ], **nav("/lovelace/soojuspump")),
    section("Ventilatsioon", [
        # Kitchen mode is 80/20 on purpose: it pressurises the kitchen so the cooker hood does the
        # extraction. Boost is 100/100 and is the mode that clears the whole house, which is
        # what a sauna or a smoking oven needs. Both belong here; they are not the same tool.
        third(mode_button("Tavaline", "mdi:fan", "normal", "green", vertical=True)),
        third(mode_button("Köök", "mdi:stove", "kitchen", "orange", vertical=True)),
        third(mode_button("Boost", "mdi:fan-plus", "boost", "purple", vertical=True)),
        third(tile("sensor.komfovent_supply_temperature", "Sissepuhe", vertical=True)),
        third(tile("sensor.komfovent_extract_temperature", "Väljatõmme", vertical=True)),
        third(tile("sensor.komfovent_panel_1_humidity", "Niiskus", vertical=True)),
        when_on("binary_sensor.komfovent_status_alarm_fault", "Ventilatsiooni viga"),
        when_on("binary_sensor.komfovent_status_alarm_warning", "Ventilatsiooni hoiatus"),
    ], badges=[{"type": "entity", "entity": MODE, "name": "Režiim", "show_state": True}], **nav("/lovelace/ventilatsioon")),
    section("Pergola", [
        tile("cover.pergola_katus", "Katus", features=[{"type": "cover-open-close"}]),
        tile("light.pergola_valgustus", "Valgustus", features=[{"type": "light-brightness"}]),
    ], **nav("/lovelace/pergola")),
    section("Süsteem", [
        {"type": "entities", "title": "Uuendused", "entities": UPDATES,
         "visibility": [{"condition": "or", "conditions": [{"condition": "state", "entity": u, "state": "on"} for u in UPDATES]}]},
        tile("sensor.nvr_ketas", "NVR ketas", color="red", visibility=[{"condition": "state", "entity": "sensor.nvr_ketas", "state_not": "OK"}]),
        *([tile(PHONE + "_battery_level", "Telefoni aku", color="red",
                visibility=[{"condition": "numeric_state", "entity": PHONE + "_battery_level", "below": 30}])] if PHONE else []),
        {"type": "markdown", "content": "Kõik korras.",
         "visibility": [{"condition": "and", "conditions": [{"condition": "state", "entity": "sensor.nvr_ketas", "state": "OK"}] +
                         [{"condition": "state", "entity": u, "state_not": "on"} for u in UPDATES]}]},
    ], **nav("/lovelace/susteem")),
]}

# The fork's price statistic (estfeed:estfeed_price) has the whole tariff price for every cached hour,
# so the month view has history from day one. apexcharts-card cannot plot an external statistic
# directly (it needs a state object), so the series borrow the price sensor as the entity and pull
# the daily aggregates over the websocket themselves.
PRICE_STAT = "estfeed:estfeed_price"
def price_stat_js(stat_type):
    return f"""
const r = await hass.callWS({{type: 'recorder/statistics_during_period', start_time: new Date(start).toISOString(),
  end_time: new Date(end).toISOString(), statistic_ids: ['{PRICE_STAT}'], period: 'day', types: ['{stat_type}']}});
return (r['{PRICE_STAT}'] || []).filter(x => x.{stat_type} != null).map(x => [x.start, x.{stat_type}]);
"""
price_month = {
    "type": "custom:apexcharts-card", "graph_span": "30d", "span": {"end": "day"},
    "header": {"show": True, "title": "Koguhind 30 päeva, €/kWh", "show_states": False},
    "yaxis": [{"min": 0, "decimals": 2}],
    "experimental": {"color_threshold": True},
    "apex_config": {"legend": {"show": True}, "plotOptions": {"bar": {"columnWidth": "70%"}},
                    "xaxis": {"labels": {"datetimeFormatter": {"day": "d. MMM"}}}},
    "series": [
        {"entity": "sensor.elektri_hind_see_tund", "name": "Keskmine", "type": "column", "float_precision": 3,
         "data_generator": price_stat_js("mean"),
         "color_threshold": [{"value": 0, "color": "#43a047"}, {"value": 0.15, "color": "#fb8c00"}, {"value": 0.25, "color": "#e53935"}]},
        {"entity": "sensor.elektri_hind_see_tund", "name": "Kõrgeim tund", "type": "line", "curve": "stepline", "stroke_width": 1,
         "color": "#90a4ae", "float_precision": 3, "data_generator": price_stat_js("max")}]}

energy = {"title": "Energia", "path": "energia", "icon": "mdi:lightning-bolt", "type": "sections", "max_columns": 2, "sections": [
    section("Hind", [price_month], column_span=2),
    section("Maja", [
        # Horizontal and half a wide section each: three numbers side by side do not fit a vertical tile on a phone.
        nowrite("sensor.maja_sel_kuul", "Sel kuul", state_content=["state", "kulu", "hind"], grid_options={"columns": 12, "rows": 1}),
        nowrite("sensor.maja_eelmine_kuu", "Eelmine kuu", state_content=["state", "kulu", "hind"], grid_options={"columns": 12, "rows": 1}),
        bars("Tarbimine päevas, kWh", [("estfeed:estfeed_consumption_642b", "kWh")], 31),
        bars("Kulu päevas, € (ilma kuutasudeta)", [("estfeed:estfeed_cost_642b", "€")], 31),
    ], column_span=2, **nav("/energy")),
    section("Suuremad tarbijad sel kuul", [
        third(tile("sensor.boiler_energy_month", "Boiler", vertical=True, **nav("/lovelace/soojuspump"))),
        third(tile("sensor.ventilatsioon_sel_kuul", "Ventilatsioon", vertical=True, **nav("/lovelace/ventilatsioon"))),
        third(tile("sensor.jarelkute_sel_kuul", "Järelküte", color="red", vertical=True, **nav("/lovelace/ventilatsioon"))),
    ], column_span=2),
]}

# One subview per camera behind the grid above. The grid stays on cheap still images
# (0.3 s, 1080p from the NVR); a live stream is only opened when a camera is tapped.
# Advanced Camera Card because the stock cards cannot zoom: here ctrl+wheel or pinch
# zooms and pans. That only buys anything on the main stream - measured 2026-09-14,
# the main stream is 2688x1520 and the substream 640x480, and both take the same
# 7-12 s to start (HLS; native WebRTC is advertised but go2rtc fails to open these
# streams, so the frontend always falls back to HLS). So the everyday grid keeps the
# substream and the zoom view takes the main one; there is no speed penalty for it.
#
# Every subview is the same viewer with a different camera selected first, because the
# card lets you swipe on to the next camera. So nothing outside the card names a camera:
# the view title stays "Kaamerad" and the card's own status bar carries the name, since
# dashboard chrome cannot follow a selection made inside a card. Per-camera state and the
# motion switches stay on the tab behind, for the same reason.
#
# Panel, not sections: a sections column stops at 500 px, which left a 2.7K stream
# as a thumbnail on a desktop. In a panel the card takes the whole area under the
# header and letterboxes the stream inside it (card `dimensions` do not apply there),
# so a desktop gets the full width and a phone gets full width with dark bands.
def cam_view(slug, name):
    others = [{"camera_entity": "camera." + s, "title": t} for s, t in CAMS if s != slug]
    return {"title": "Kaamerad", "path": "kaamera-" + slug, "icon": "mdi:cctv", "type": "panel",
            "subview": True, "cards": [
        {"type": "custom:advanced-camera-card",
         "cameras": [{"camera_entity": "camera." + slug, "title": name}] + others,
         "view": {"default": "live"}, "menu": {"style": "hover"},
         "live": {"display": {"mode": "single"}},  # grid mode would open every stream at once
         "status_bar": {"style": "outside", "position": "bottom"}}]}

cameras = {"title": "Kaamerad", "path": "kaamerad", "icon": "mdi:cctv", "type": "sections", "max_columns": 3,
 # Kodu shape: cameras as they were, NVR and per-camera motion switches in one section, no captions. The NVR disk
 # badge shows only when the disk is not OK. Motion is too noisy for a badge (fires on insects and rain).
 # The alarm moved to its own Valve tab once PAI landed; the leak-sensor plan is still in khe-meta.
 "badges": [
    {"type": "entity", "entity": "sensor.nvr_ketas", "name": "NVR ketas", "color": "red", "show_name": True, "show_state": True,
     "visibility": [{"condition": "state", "entity": "sensor.nvr_ketas", "state_not": "OK"}]},
 ],
 "sections": [
    section("Kaamerad", [
        {"type": "picture-glance", "camera_image": "camera." + slug + "_alamvoog", "entity": "camera." + slug + "_alamvoog", "title": n, "camera_view": "auto",
         "entities": [{"entity": "binary_sensor." + slug + "_liikumine"}], **nav("/lovelace/kaamera-" + slug)}
        for slug, n in CAMS], column_span=3),
    section("NVR", [
        *row([
            nowrite("sensor.nvr_ketas", "Ketas", vertical=True),
            # Opens the NVR vendor's phone app via its URL scheme (from the local house file); the NVR web UI is too slow to be worth a button.
            *([{"type": "tile", "entity": "sensor.nvr_ketas", "name": "Ava NVR", "icon": "mdi:cellphone-play", "hide_state": True, "vertical": True,
                "tap_action": {"action": "url", "url_path": NVR_APP}, "icon_tap_action": {"action": "url", "url_path": NVR_APP}}] if NVR_APP else [])]),
        # Per-camera motion detection. The camera integration switches these back on at every reload, so treat them as a temporary mute.
        *row([tile("switch." + slug + "_liikumistuvastus", n, vertical=True) for slug, n in CAMS]),
    ], column_span=3),
]}

# Alarm zones grouped by what they are rather than by panel numbering, and
# every card here keeps its size when state changes. The first version made the
# open-zone section appear and disappear, which moved the whole page every time
# a PIR fired: "show faults only when active" is a rule for rare faults, and
# motion is the most volatile thing in the house. So contacts are always on
# screen and change colour, motion appears only as history, and the two counts
# that would otherwise need a growing list are template sensors.
DOORS = [("binary_sensor.peauks", "Peauks"), ("binary_sensor.elutoa_uks", "Elutoa uks"),
         ("binary_sensor.vannitoa_uks", "Vannitoa uks")]
# Nine PIRs and three contacts. The four zones the installer called
# MAGAMISTUBA turned out to be motion as well, settled by how often they
# switch rather than by the label. Names come from the entity registry: two of
# these rooms are named after the children and this repo is public.
SHARED = ["binary_sensor.kook_liikumine", "binary_sensor.elutuba_liikumine",
          "binary_sensor.koridor_liikumine", "binary_sensor.garaaz_liikumine",
          "binary_sensor.tehnoruum_liikumine"]
PRIVATE = ["binary_sensor.vanemate_tuba_liikumine", "binary_sensor.magamistuba_2",
           "binary_sensor.magamistuba_4", "binary_sensor.kontor_liikumine"]

# A history graph is the wrong instrument for motion. A PIR is on for seconds,
# so on a 24 h axis every event is a sub-pixel hairline - the chart is legible
# only for things with duration, like a heater running. The question people
# actually ask a motion sensor is "when was anyone last in there", so the
# answer is a timestamp per room: one row each, fixed height, and the row
# changes text and colour without ever changing size.
def motion_list(groups):
    rows = []
    for label, ents in groups:
        rows.append({"type": "section", "label": label})
        rows += [{"entity": e, "secondary_info": "last-changed"} for e in ents]
    return {"type": "entities", "entities": rows, "state_color": True}

def armed(entity, name):
    return {"type": "tile", "entity": entity, "name": name, "features": [
        {"type": "alarm-modes", "modes": ["armed_away", "armed_home", "armed_night", "disarmed"]}]}
def rare(entity, name, state=None, state_not=None):
    cond = {"condition": "state", "entity": entity}
    cond.update({"state": state} if state else {"state_not": state_not})
    return {"type": "entity", "entity": entity, "name": name, "color": "red",
            "show_name": True, "show_state": False, "visibility": [cond]}

valve = {"title": "Valve", "path": "valve", "icon": "mdi:shield-home", "type": "sections", "max_columns": 2,
 # The two partition states answer what this tab exists for. An open-contact
 # count used to sit here too and was dropped: with exactly three contacts,
 # the door tiles a few pixels below say the same thing with more detail. The
 # other two badges are genuinely rare, so the row reflowing when they appear
 # is a cost worth paying.
 "badges": [
    {"type": "entity", "entity": "alarm_control_panel.maja", "name": "Maja", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "alarm_control_panel.garaaz", "name": "Garaaž", "show_name": True, "show_state": True},
    rare("binary_sensor.suitsuandurid", "Tulekahju", state="on"),
    rare("sensor.valve_uhendus", "Ühendus katkes", state_not="online"),
 ],
 "sections": [
    # Tiles rather than keypad cards: the keypad is a tall block to look at all
    # day for something you tap twice, and the tile feature raises the code
    # dialog by itself when disarming asks for one.
    section("Valve", [armed("alarm_control_panel.maja", "Maja"),
                      armed("alarm_control_panel.garaaz", "Garaaž")], column_span=2),
    section("Uksed", [
        {"type": "horizontal-stack", "cards": [tile(e, n, vertical=True) for e, n in DOORS]},
    ], column_span=2),
    section("Liikumine", [motion_list([("Ühisruumid", SHARED), ("Toad", PRIVATE)])], column_span=2),
    section("Süsteem", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.valve_aku", "Aku", vertical=True),
            nowrite("sensor.valve_uhendus", "Ühendus", vertical=True)]},
        # Smoke was a badge only, which meant it was invisible until the house
        # was already on fire. You need to see that it is connected on a normal
        # day too, so it leads the row that answers "is anything wrong".
        {"type": "horizontal-stack", "cards": [
            tile("binary_sensor.suitsuandurid", "Suitsuandurid", vertical=True),
            tile("binary_sensor.valve_rikkumine", "Rikkumine", vertical=True),
            tile("binary_sensor.valissireen", "Sireen", vertical=True)]},
    ], column_span=2),
]}

soojuspump = {"title": "Soojuspump", "path": "soojuspump", "icon": "mdi:heat-pump", "type": "sections", "max_columns": 2,
 # Kodu shape: heating and DHW state as badges plus a settings badge, one row of vertical tiles per section, charts only where the number moves.
 "badges": [
    {"type": "entity", "entity": "switch.space_heating_climate_control", "name": "Küte", "show_name": True, "show_state": True},
    {"type": "entity", "entity": DHW, "name": "Boiler", "show_name": True, "show_state": True, "state_content": "current_temperature"},
    {"type": "entity", "entity": "switch.space_heating_climate_control", "name": "Seaded", "icon": "mdi:tune", "color": "grey", "show_name": True, "show_state": False,
     "tap_action": {"action": "navigate", "navigation_path": "/lovelace/soojuspump-seaded"}},
 ],
 "sections": [
    section("Küte", [
        *row([
            nowrite("sensor.space_heating_leaving_water_temperature", "Küttevesi", vertical=True),
            # "Sees" is the Komfovent wall panel in the utility room, the one indoor thermometer the house has.
            nowrite("sensor.komfovent_panel_1_temperature", "Sees", vertical=True),
            nowrite("sensor.space_heating_outdoor_temperature", "Väljas", vertical=True),
            nowrite("number.space_heating_temperature_control", "Kõvera nihe", vertical=True)]),
        when_on("binary_sensor.space_heating_unit_state", "Soojuspumba viga"),
        hist("Küttevesi ja välistemperatuur 48 h", [("sensor.space_heating_leaving_water_temperature", "Küttevesi"),
                                                    ("sensor.space_heating_outdoor_temperature", "Väljas")], 48),
    ]),
    section("Soe vesi", [
        *row([
            nowrite("sensor.boileri_vee_temperatuur", "Vesi", color="blue", vertical=True),
            nowrite(DHW, "Siht", state_content=["temperature"], vertical=True),
            nowrite("sensor.boiler_energy_today", "Täna", vertical=True),
            nowrite("sensor.boiler_energy_month", "Sel kuul", vertical=True)]),
        when_on("binary_sensor.hot_water_tank_state", "Boileri viga"),
        hist("Boileri vee temperatuur 48 h", [("sensor.boileri_vee_temperatuur", "Boileri vesi")], 48),
        # Daikin's own DHW electricity counter, whole kWh. Space-heating kWh are deliberately absent: that counter is broken on the unit.
        daikin_bars("Boiler päevas, kWh", "sensor.boiler_energy_today", "15d", "day", DAYS_JS, {"day": "dd.MM"}),
        daikin_bars("Boiler kuus, kWh", "sensor.boiler_energy_month", "731d", "month", MONTHS_JS, {"month": "MMM yy", "year": "yyyy"}),
    ]),
]}

ventilatsioon = {"title": "Ventilatsioon", "path": "ventilatsioon", "icon": "mdi:fan", "type": "sections", "max_columns": 3,
 # Same shape as Kodu: one row of vertical tiles per section, a chart only where the number moves, no captions.
 # Mode and ECO ride as badges; the settings subview is a badge too, so the view has no card that is only a link.
 "badges": [
    {"type": "entity", "entity": MODE, "name": "Režiim", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "switch.komfovent_eco_mode", "name": "ECO", "show_name": True, "show_state": True},
    {"type": "entity", "entity": MODE, "name": "Seaded", "icon": "mdi:tune", "color": "grey", "show_name": True, "show_state": False,
     "tap_action": {"action": "navigate", "navigation_path": "/lovelace/komfovent-seaded"}},
 ],
 "sections": [
    section("Õhk", [
        *row([
            nowrite("sensor.komfovent_supply_temperature", "Sissepuhe", vertical=True),
            nowrite("sensor.komfovent_extract_temperature", "Väljatõmme", vertical=True),
            nowrite("sensor.komfovent_outdoor_temperature", "Välisõhk", vertical=True),
            nowrite("sensor.komfovent_panel_1_humidity", "Niiskus", vertical=True)]),
        hist("Temperatuurid 48 h", [("sensor.komfovent_supply_temperature", "Sissepuhe"), ("sensor.komfovent_extract_temperature", "Väljatõmme"),
                                    ("sensor.komfovent_outdoor_temperature", "Välisõhk")], 48),
    ]),
    section("Soojusvaheti", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.komfovent_heat_exchanger", "Vaheti", vertical=True),
            nowrite("sensor.komfovent_heat_exchanger_efficiency", "Kasutegur", vertical=True),
            nowrite("sensor.komfovent_heat_recovery", "Tagastus", vertical=True)]},
        tile("sensor.komfovent_filter_clogging", "Filter", features=[{"type": "bar-gauge", "min": 0, "max": 100}], features_position="inline"),
        when_on("binary_sensor.komfovent_status_flow_down", "Õhuvool alandatud"),
        when_on("binary_sensor.komfovent_status_alarm_fault", "Viga"),
        when_on("binary_sensor.komfovent_status_alarm_warning", "Hoiatus"),
        tile("sensor.komfovent_active_alarms", "Aktiivsed alarmid", color="red",
             visibility=[{"condition": "state", "entity": "sensor.komfovent_active_alarms", "state_not": ""}]),
        # The payback chart. The heater is not plotted: under ECO it is zero by design, which the month tile and the alert cover.
        bars("Tagastatud päevas, kWh", [("sensor.komfovent_total_recovered_energy", "Tagastatud")], 14),
    ]),
    section("Energia", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.komfovent_power_consumption", "Võimsus", vertical=True),
            nowrite("sensor.ventilatsioon_sel_kuul", "Kuu kokku", vertical=True),
            nowrite("sensor.jarelkute_sel_kuul", "Kuu järelküte", color="red", vertical=True)]},
        bars("Seade päevas, kWh", [("sensor.komfovent_total_ahu_energy", "Seade")], 31),
    ]),
]}

# Pergola. The front page does only what gets done every day, and does it to
# both units at once: the roof, the light, and the number that tells you
# whether to bother. One side at a time, the automation switch and everything
# seasonal live in the subview. House shape otherwise: a row of tiles per
# section, the common action as a row of three like the ventilation modes,
# nothing full width but the forecast card.
#
# Two things are deliberately on neither page. The RF channel (dp102) is
# write-only in practice - the device never reports it - and rewriting it can
# leave a handheld remote unpaired, so it stays on the device page. The
# last-command sensors read Stop almost always, because dp2 resets itself.
# The roof reports no position at all, so no tile pretends to show one.
def roof(name, icon, service, color=None):
    act = {"action": "perform-action", "perform_action": service,
           "target": {"entity_id": "cover.pergola_katus"}}
    return third(tile("cover.pergola_katus", name, icon=icon, color=color, hide_state=True,
                      vertical=True, tap_action=act, icon_tap_action=act))

pergola = {"title": "Pergola", "path": "pergola", "icon": "mdi:awning-outline", "type": "sections", "max_columns": 3,
 "badges": [
    {"type": "entity", "entity": "sensor.sademed_praegu", "name": "Sajab", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "input_boolean.pergola_katuse_automaatika", "name": "Autom.", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "input_boolean.pergola_valguse_automaatika", "name": "Autom.", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "input_boolean.pergola_katuse_automaatika", "name": "Seaded", "icon": "mdi:tune", "color": "grey", "show_name": True, "show_state": False,
     "tap_action": {"action": "navigate", "navigation_path": "/lovelace/pergola-seaded"}},
 ],
 "sections": [
    section("Katus", [
        roof("Ava", "mdi:arrow-up", "cover.open_cover", "green"),
        roof("Stopp", "mdi:stop", "cover.stop_cover"),
        roof("Sulge", "mdi:arrow-down", "cover.close_cover", "blue"),
        note("Mõlemad korraga. Poolenurk: Stopp keset liikumist."),
    ]),
    section("Valgus", [
        {"type": "horizontal-stack", "cards": [
            tile("light.pergola_valgustus", "Valgustus", features=[{"type": "light-brightness"}]),
            tile("input_select.pergola_valguse_toon", "Toon", hide_state=True, features=[{"type": "select-options"}])]},
    ]),
    # Every number once. "Sajab now" is the badge, so the section carries what
    # comes next and how warm it is out; the forecast card drops its current
    # block, which repeated both. The outdoor temperature is the Komfovent's
    # own sensor on the house, not the grid forecast's value for the area.
    section("Ilm", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.sademed_kahe_tunniga", "Sademed kahe tunniga", vertical=True),
            nowrite("sensor.komfovent_outdoor_temperature", "Välisõhk", vertical=True)]},
        {"type": "weather-forecast", "entity": "weather.forecast_kodu", "forecast_type": "hourly",
         "show_current": False, "show_forecast": True},
    ]),
]}

pergola_seaded = {"title": "Pergola seaded", "path": "pergola-seaded", "icon": "mdi:tune", "type": "sections", "subview": True, "max_columns": 2, "sections": [
    section("Katus poolte kaupa", [
        {"type": "horizontal-stack", "cards": [
            tile("cover.pergola_parem", "Parem", vertical=True, features=[{"type": "cover-open-close"}]),
            tile("cover.pergola_vasak", "Vasak", vertical=True, features=[{"type": "cover-open-close"}])]},
    ]),
    section("Valgus poolte kaupa", [
        {"type": "horizontal-stack", "cards": [
            tile("light.pergola_parem_valgustus", "Parem", vertical=True, features=[{"type": "light-brightness"}]),
            tile("light.pergola_vasak_valgustus", "Vasak", vertical=True, features=[{"type": "light-brightness"}])]},
        {"type": "horizontal-stack", "cards": [
            tile("select.pergola_parem_valguse_toon", "Toon parem", vertical=True),
            tile("select.pergola_vasak_valguse_toon", "Toon vasak", vertical=True)]},
    ]),
    # Grouped by rule, and every part of a rule is a control. Nothing here
    # needs a sentence explaining it, which is just as well: a subtitle
    # heading truncates to one line and a markdown card was too much page.
    section("Katuse automaatika", [
        {"type": "horizontal-stack", "cards": [
            tile("input_boolean.pergola_katuse_automaatika", "Reegel", vertical=True),
            tile("input_boolean.pergola_vihma_teavitus", "Teavitus", vertical=True)]},
        {"type": "horizontal-stack", "cards": [
            tile("input_number.pergola_teavituse_vaikus", "Vaikus", vertical=True, hide_state=True,
                 features=[{"type": "numeric-input", "style": "buttons"}]),
            nowrite("input_datetime.pergola_vihmateade", "Viimane teade", vertical=True)]},
    ]),
    section("Valguse automaatika", [
        {"type": "horizontal-stack", "cards": [
            tile("input_boolean.pergola_valguse_automaatika", "Reegel", vertical=True),
            tile("input_boolean.pergola_valgus_ainult_kodus", "Ainult kui kodus", vertical=True)]},
        {"type": "horizontal-stack", "cards": [
            tile("input_number.pergola_valgus_nihe", "Enne loojangut", vertical=True, hide_state=True,
                 features=[{"type": "numeric-input", "style": "buttons"}]),
            tile("input_datetime.pergola_valgus_kustub", "Kustub", vertical=True)]},
        {"type": "horizontal-stack", "cards": [
            tile("input_number.pergola_valguse_heledus", "Heledus", vertical=True, hide_state=True,
                 features=[{"type": "numeric-input", "style": "buttons"}]),
            tile("input_select.pergola_ohtune_toon", "Õhtune toon", vertical=True, hide_state=True,
                 features=[{"type": "select-options"}])]},
    ]),
]}

susteem = {"title": "Süsteem", "path": "susteem", "icon": "mdi:home-assistant", "type": "sections", "subview": True, "max_columns": 2, "sections": [
    # Kodu shape, no captions. Operational notes that used to sit here (backup.sh, companion-app sensors, recorder
    # retention) live in khe-meta's house/home-assistant-plan.md. The NVR disk is on Valve and Kodu, not repeated here.
    section("Uuendused", [
        {"type": "entities", "entities": UPDATES},
    ]),
    section("Telefon", [
        # SSID is left out: iOS only reports it with precise-location permission, so the tile sat on "unavailable".
        *row([
            *[nowrite(e, n.removesuffix(" on"), vertical=True) for e, n in PEOPLE[:1]],
            *([nowrite(PHONE + "_battery_level", "Aku", vertical=True),
               nowrite(PHONE + "_battery_state", "Laadimine", vertical=True),
               nowrite(PHONE + "_connection_type", "Ühendus", vertical=True)] if PHONE else [])]),
    ]),
    section("Kaamerate põhivood", [
        # Full-resolution live streams as tiles; the same streams are zoomable on the Kaamerad tab.
        *row([tile("camera." + slug, n, vertical=True) for slug, n in CAMS]),
    ], column_span=2),
    section("Nord Pool toorandmed", [
        # 15-minute spot without fees, the 15-minute total, and how far the forecast reaches; Kodu uses hourly means because the meter bills hourly.
        *row([
            nowrite("sensor.nord_pool_ee_praegune_hind", "Börs praegu", vertical=True),
            nowrite("sensor.nord_pool_ee_jargmine_hind", "Börs järgmine", vertical=True),
            nowrite("sensor.elektri_hind_kokku", "Kokku, 15 min", vertical=True),
            nowrite(FORECAST, "Prognoos katab", vertical=True)]),
        *row([
            nowrite("sensor.nord_pool_ee_madalaim_hind", "Täna madalaim", vertical=True),
            nowrite("sensor.nord_pool_ee_korgeim_hind", "Täna kõrgeim", vertical=True)]),
    ], column_span=2),
]}

def mode_row(key, timer=False):
    """One mode's settings as grid cells of vertical tiles: fans, setpoint, heater flag, optional timer. Taps open more-info to edit."""
    # Short names: five vertical tiles in a row truncate "Sissepuhe %" on a phone, and the value already carries the unit.
    cards = [tile(f"number.komfovent_{key}_supply_flow", "Sisse", vertical=True),
             tile(f"number.komfovent_{key}_extract_flow", "Välja", vertical=True),
             tile(f"number.komfovent_{key}_temperature", "Sihttemp", vertical=True),
             confirm(f"switch.komfovent_{key}_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red", vertical=True)]
    if timer: cards.append(tile(f"number.komfovent_{key}_timer", "Kestus min", vertical=True))
    return row(cards)

komfovent_seaded = {"title": "Ventilatsiooni seaded", "path": "komfovent-seaded", "icon": "mdi:tune", "type": "sections", "subview": True, "max_columns": 3, "sections": [
    section("Juhtimine", [
        # No inline dropdown: the integration ships raw option keys ("working_week"), so the tap opens more-info to pick instead.
        tile(MODE, "Režiim"),
        tile("select.komfovent_scheduler_mode", "Ajakava"),
        tile("switch.komfovent_auto_mode", "Automaatrežiim"),
        confirm("switch.komfovent_power", "Seade sees", "Lülitad kogu ventilatsiooni. Kindel?"),
    ]),
    # ECO is the strategy since 2026-09-13: heater blocked, exchanger always on. Free cooling is the one seasonal switch
    # (on in late spring for night cooling, off in autumn). The heat-recovery select writes fine but the integration
    # cannot read that register back, so its tile is always blank; the name says so.
    section("ECO", [
        tile("switch.komfovent_eco_mode", "ECO sees"),
        confirm("switch.komfovent_eco_heater_blocking", "Kütteblokeering", "Väljalülitamine lubab elektrilise järelkütte. Kindel?", color="red"),
        confirm("switch.komfovent_eco_free_heating_cooling", "Vaba jahutus", "Suvine vaba jahutus. Sees: soojusvaheti seisab, kui välisõhk on toast jahedam. Talvel peab olema väljas. Kindel?"),
        tile("select.komfovent_eco_heat_recovery", "Soojustagastus"),  # reads back as unknown; tap opens more-info where the option can still be set
        tile("number.komfovent_eco_min_supply_temperature", "Min sissepuhe"),
        # 30 C since 2026-09-14, was 25. The ceiling applies in every mode, and with the exchanger
        # at 100 % the extract air alone pushes the supply past 25 C whenever the house is warm.
        # ECO then had no lever left but to throttle the fans, down to 25 % during a sauna evening.
        tile("number.komfovent_eco_max_supply_temperature", "Max sissepuhe"),
    ]),
    section("Tavaline", mode_row("normal")),
    section("Köök", mode_row("kitchen", timer=True)),
    section("Boost", mode_row("boost")),
    section("Kamin", mode_row("fireplace", timer=True)),
    section("Eemal", mode_row("away")),
    section("Harva kasutatavad režiimid",
        [note("Intensiivne"), *mode_row("intensive"), note("Override"), *mode_row("override", timer=True),
        {"type": "horizontal-stack", "cards": [
            tile("number.komfovent_override_delay_start", "Viide start", vertical=True),
            tile("number.komfovent_override_delay_stop", "Viide stopp", vertical=True)]},
        note("Puhkus"),
        {"type": "horizontal-stack", "cards": [
            tile("number.komfovent_holidays_temperature", "Sihttemp", vertical=True),
            confirm("switch.komfovent_holidays_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red", vertical=True),
            tile("select.komfovent_holidays_micro_ventilation", "Mikroventilatsioon", vertical=True)]},
    ], column_span=2),
    section("Hooldus", [
        {"type": "button", "name": "Puhaste filtrite kalibreerimine", "icon": "mdi:gesture-tap-button", "tap_action": {"action": "perform-action", "perform_action": "button.press", "target": {"entity_id": "button.komfovent_clean_filters_calibration"}, "confirmation": {"text": "Kindel?"}}},
        {"type": "button", "name": "Kustuta alarmid", "icon": "mdi:gesture-tap-button", "tap_action": {"action": "perform-action", "perform_action": "button.press", "target": {"entity_id": "button.komfovent_clear_active_alarms"}, "confirmation": {"text": "Kindel?"}}},
        {"type": "button", "name": "Sea seadme kell", "icon": "mdi:gesture-tap-button", "tap_action": {"action": "perform-action", "perform_action": "button.press", "target": {"entity_id": "button.komfovent_set_system_time"}, "confirmation": {"text": "Kindel?"}}},
    ]),
]}

soojuspump_seaded = {"title": "Soojuspumba seaded", "path": "soojuspump-seaded", "icon": "mdi:tune", "type": "sections", "subview": True, "max_columns": 2, "sections": [
    section("Küte", [
        confirm("switch.space_heating_climate_control", "Küte", "Lülitad maja kütte. Kindel?"),
        tile("select.space_heating_operation_mode", "Kütte režiim"),  # raw option keys from the integration; tap opens the picker
        # The one heating knob the unit exposes: +1 shifts the weather curve one degree up, -1 down.
        tile("number.space_heating_temperature_control", "Küttevee nihe", features=[{"type": "numeric-input", "style": "buttons"}]),
    ]),
    section("Soe vesi", [
        note("Siht 55 °C, mitte alla 45 °C (legionella)."),
        tile("water_heater.hot_water_tank_domestic_hot_water_tank", "Boiler", state_content=["state", "current_temperature"],
             features=[{"type": "target-temperature"}]),
        *dhw_boost(),
    ]),
]}

config = {"title": "Kodu", "views": [home, energy, soojuspump, ventilatsioon, pergola, valve, cameras, susteem,
                                    komfovent_seaded, soojuspump_seaded, pergola_seaded] + [cam_view(s, n) for s, n in CAMS]}

async def main():
    async with websockets.connect(f"ws://{HA}/api/websocket", max_size=2**24) as ws:
        await ws.recv(); await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        assert json.loads(await ws.recv())["type"] == "auth_ok"
        mid = [0]
        async def call(**msg):
            mid[0] += 1; msg["id"] = mid[0]; await ws.send(json.dumps(msg))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == mid[0]: return r
        r = await call(type="lovelace/config/save", url_path=URL, config=config)
        print("save:", "ok" if r.get("success") else r.get("error"))
        r = await call(type="lovelace/config", url_path=URL)
        v = r["result"]["views"]; print("views:", [x["title"] for x in v], "| cards:", sum(len(c["cards"]) for x in v for c in x.get("sections", [x])))
asyncio.run(main())
