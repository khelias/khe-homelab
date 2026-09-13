#!/usr/bin/env python3
"""Generate and save the Home Assistant Overview dashboard for the house.

The dashboard is storage-mode config in HA's .storage (backed up nightly by
backup.sh); this script is its source of truth. Edit here, run, and HA picks
the new config up live. Layout and the reasoning behind it are described in
docs/home-assistant-plan.md ("Dashboard").

Usage:  ha-dashboard.py            (saves to the "lovelace" Overview)
Needs:  python3 with `websockets`, the HA long-lived token in
        ~/.config/khe/ha-token, optional family list in ~/.config/khe/ha-people.json.
"""
import asyncio, json, os, websockets
HA = "192.168.0.11:8123"
TOKEN = open(os.path.expanduser("~/.config/khe/ha-token")).read().strip()
URL = "lovelace"  # the Overview, a dashboard entry since the 2026.9 migration
CAMS = [tuple(c) for c in _house.get("cams", [])]
FORECAST = "sensor.elektri_hinna_prognoos"
DHW = "water_heater.hot_water_tank_domestic_hot_water_tank"
# Presence badges render "<name> <state>", so the verb rides in the name ("Kaido on" -> "Kaido on Kodus").
# Family members are read from an untracked local file (this repo is public): a JSON list of [entity_id, label].
_people_file = os.path.expanduser("~/.config/khe/ha-people.json")
PEOPLE = json.load(open(_people_file)) if os.path.exists(_people_file) else [("person.owner", "Kaido on")]  # badge renders "<name> <state>"
UPDATES = ["update.hacs_update", "update.komfovent_update", "update.daikin_altherma_update", "update.nvr_camera_update", "update.apexcharts_card_update"]

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
def hist(title, ents, hours):
    return {"type": "history-graph", "title": title, "hours_to_show": hours,
            "entities": [{"entity": e, "name": n} for e, n in ents]}
def section(title, cards, column_span=1, **heading):
    return {"type": "grid", "column_span": column_span, "cards": [{"type": "heading", "heading": title, **heading}] + cards}
def nav(path):
    return {"tap_action": {"action": "navigate", "navigation_path": path}}

price_chart = {
    "type": "custom:apexcharts-card", "graph_span": "2d", "span": {"start": "day"},
    "header": {"show": True, "title": "Hind täna ja homme, €/kWh (tunni keskmine)", "show_states": False},
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
def action_tile(entity, name, icon, color, perform_action, data, text):
    """Quick-mode tile: same size as the other tiles, state hidden, tap runs an action after a confirmation."""
    act = {"action": "perform-action", "perform_action": perform_action, "target": {"entity_id": entity},
           "data": data, "confirmation": {"text": text}}
    return tile(entity, name, icon=icon, color=color, hide_state=True, tap_action=act, icon_tap_action=act)
def mode_button(name, icon, option, color=None):
    return action_tile(MODE, name, icon, color, "select.select_option", {"option": option},
                       f"Ventilatsioon režiimile {name}?")

def note(text):
    return {"type": "heading", "heading": text, "heading_style": "subtitle"}
def bars(title, ents, days, stat="change"):
    return {"type": "statistics-graph", "title": title, "chart_type": "bar", "period": "day", "days_to_show": days, "hide_legend": len(ents) == 1, "min_y_axis": 0,
            "stat_types": [stat], "entities": [{"entity": e, "name": n} for e, n in ents]}


def confirm(entity, name, text, **kw):
    """Tile whose tap and icon tap both toggle after a confirmation dialog."""
    act = {"action": "toggle", "confirmation": {"text": text}}
    return tile(entity, name, tap_action=act, icon_tap_action=act, **kw)

FAULTS = [("binary_sensor.space_heating_unit_state", "Soojuspumba viga"), ("binary_sensor.hot_water_tank_state", "Boileri viga"),
          ("binary_sensor.komfovent_status_alarm_fault", "Ventilatsiooni viga"), ("binary_sensor.komfovent_status_alarm_warning", "Ventilatsiooni hoiatus")]

home = {"title": "Kodu", "path": "kodu", "icon": "mdi:home", "type": "sections", "max_columns": 2,
 "badges": [
    *[{"type": "entity", "entity": e, "name": n, "show_name": True, "show_state": True} for e, n in PEOPLE],
 ] + [
    {"type": "entity", "entity": e, "name": n, "color": "red", "show_name": True, "show_state": False, "visibility": [{"condition": "state", "entity": e, "state": "on"}]}
    for e, n in FAULTS
 ],
 "sections": [
    section("Elekter", [
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
        action_tile(DHW, "Kiirsoojendus", "mdi:water-boiler", "orange", "water_heater.set_operation_mode",
                    {"operation_mode": "performance"}, "Boileri kiirsoojendus (Daikin Powerful) sisse? Lõpeb ise, kui vesi on soe."),
        when_on("binary_sensor.hot_water_tank_state", "Boileri viga"),
    ], **nav("/lovelace/soojuspump")),
    section("Ventilatsioon", [
        mode_button("Köök", "mdi:stove", "kitchen", "orange"),
        mode_button("Tavaline", "mdi:fan", "normal", "green"),
        third(tile("sensor.komfovent_supply_temperature", "Sissepuhe", vertical=True)),
        third(tile("sensor.komfovent_extract_temperature", "Väljatõmme", vertical=True)),
        third(tile("sensor.komfovent_panel_1_humidity", "Niiskus", vertical=True)),
        when_on("binary_sensor.komfovent_status_alarm_fault", "Ventilatsiooni viga"),
        when_on("binary_sensor.komfovent_status_alarm_warning", "Ventilatsiooni hoiatus"),
    ], badges=[{"type": "entity", "entity": MODE, "name": "Režiim", "show_state": True}], **nav("/lovelace/ventilatsioon")),
    section("Süsteem", [
        {"type": "entities", "title": "Uuendused", "entities": UPDATES,
         "visibility": [{"condition": "or", "conditions": [{"condition": "state", "entity": u, "state": "on"} for u in UPDATES]}]},
        tile("sensor.nvr_ketas", "NVR ketas", color="red", visibility=[{"condition": "state", "entity": "sensor.nvr_ketas", "state_not": "OK"}]),
        tile("sensor.phone_battery_level", "Telefoni aku", color="red",
             visibility=[{"condition": "numeric_state", "entity": "sensor.phone_battery_level", "below": 30}]),
        {"type": "markdown", "content": "Kõik korras.",
         "visibility": [{"condition": "and", "conditions": [{"condition": "state", "entity": "sensor.nvr_ketas", "state": "OK"}] +
                         [{"condition": "state", "entity": u, "state_not": "on"} for u in UPDATES]}]},
    ], **nav("/lovelace/susteem")),
]}

price_month = {
    "type": "custom:apexcharts-card", "graph_span": "30d", "span": {"end": "day"},
    "header": {"show": True, "title": "Koguhind 30 päeva, €/kWh (päeva keskmine ja kõrgeim tund)", "show_states": False},
    "yaxis": [{"min": 0, "decimals": 2}],
    "experimental": {"color_threshold": True},
    "apex_config": {"legend": {"show": True}, "plotOptions": {"bar": {"columnWidth": "70%"}},
                    "xaxis": {"labels": {"datetimeFormatter": {"day": "d. MMM"}}}},
    "series": [
        {"entity": "sensor.elektri_hind_see_tund", "name": "Keskmine", "type": "column", "float_precision": 3,
         "statistics": {"type": "mean", "period": "day"},
         "color_threshold": [{"value": 0, "color": "#43a047"}, {"value": 0.15, "color": "#fb8c00"}, {"value": 0.25, "color": "#e53935"}]},
        {"entity": "sensor.elektri_hind_see_tund", "name": "Kõrgeim tund", "type": "line", "curve": "stepline", "stroke_width": 1,
         "color": "#90a4ae", "float_precision": 3, "statistics": {"type": "max", "period": "day"}}]}

energy = {"title": "Energia", "path": "energia", "icon": "mdi:lightning-bolt", "type": "sections", "max_columns": 2, "sections": [
    section("Hind", [price_month], column_span=2),
    section("Maja", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.maja_sel_kuul", "Sel kuul", state_content=["state", "kulu", "hind"], vertical=True),
            nowrite("sensor.maja_eelmine_kuu", "Eelmine kuu", state_content=["state", "kulu", "hind"], vertical=True)]},
        bars("Tarbimine päevas, kWh", [("estfeed:estfeed_consumption_642b", "kWh")], 31),
        bars("Kulu päevas, € (ilma kuutasudeta)", [("estfeed:estfeed_cost_642b", "€")], 31),
    ], column_span=2, **nav("/energy")),
    section("Suuremad tarbijad sel kuul", [
        third(tile("sensor.boiler_energy_month", "Boiler", vertical=True, **nav("/lovelace/soojuspump"))),
        third(tile("sensor.ventilatsioon_sel_kuul", "Ventilatsioon", vertical=True, **nav("/lovelace/ventilatsioon"))),
        third(tile("sensor.jarelkute_sel_kuul", "Järelküte", color="red", vertical=True, **nav("/lovelace/ventilatsioon"))),
    ], column_span=2),
]}

cameras = {"title": "Valve", "path": "valve", "icon": "mdi:shield-home", "type": "sections", "max_columns": 2, "sections": [
    section("Kaamerad", [
        note("Pilt uueneb iga 10 s, klõps avab alamvoo otsepildi, mis käivitub kiiremini kui põhivoog. Täisresolutsiooni põhivood on Süsteemi alamvaates. Ikoon pildi nurgas on NVR-i liikumistuvastus, mis reageerib ka putukatele ja vihmale, seega liikumise ajalugu siin ei näidata enne, kui NVR-is on tundlikkus ja tuvastusalad paika pandud."),
    ] + [
        {"type": "picture-glance", "camera_image": "camera." + slug + "_alamvoog", "entity": "camera." + slug + "_alamvoog", "title": n, "camera_view": "auto",
         "entities": [{"entity": "binary_sensor." + slug + "_liikumine"}]}
        for slug, n in CAMS], column_span=2),
    section("Salvesti", [
        note("Järelvaatamine on NVR-i enda veebiliideses, mis avaneb ainult koduvõrgus või Tailscale'iga ja 2019. aasta püsivara tõttu ilmselt ainult arvutis. HA-sse ta ennast raamida ei lase (X-Frame-Options)."),
        tile("sensor.nvr_ketas", "NVR ketas"),
        {"type": "button", "name": "Ava NVR-i veebiliides", "icon": "mdi:open-in-new",
         "tap_action": {"action": "url", "url_path": "http://192.168.0.x/"}},
    ]),
    section("Liikumistuvastus", [
        note("Kaamera kaupa sisse/välja. Tundlikkus ja tuvastusalad on NVR-i enda seadetes."),
    ] + [tile("switch." + slug + "_liikumistuvastus", n) for slug, n in CAMS]),
    section("Alarmikeskus (tuleb)", [
        note("alarm panel on võrgus (192.168.0.x), aga ei ava ühtegi porti, seega IP150 võrgumoodulit tal pole. HA-sse saab ta HACS-i PAI integratsiooniga kas IP150 mooduli või jadaliidese kaudu. Siia tulevad valve olek, tsoonid ja sisse/välja lülitamine."),
    ]),
    section("Lekkeandurid (tuleb)", [
        note("Zigbee lekkeandurid tehnoruumi, köögi ja vannitubade alla, kui Zigbee koordinaator on olemas. Siia tuleb iga anduri olek ja häire ülaribale."),
    ]),
]}

lights = {"title": "Tuled", "path": "tuled", "icon": "mdi:lightbulb-group", "type": "sections", "max_columns": 2, "sections": [
    section("Tuled (tuleb)", [
        note("Philips Hue pirnid on Zigbee seadmed ja lähevad HA-sse otse, ilma Hue sillata. Vaja on Zigbee koordinaatorit (nt SMLIGHT SLZB-06, võrgukaabliga) ja Zigbee2MQTT konteinerit homelabis, siis pirnid tehaseseadetele ja paaritada. Siia tulevad tuled tubade kaupa, iga tuba oma sektsioon."),
    ]),
]}

soojuspump = {"title": "Soojuspump", "path": "soojuspump", "icon": "mdi:heat-pump", "type": "sections", "max_columns": 2, "sections": [
    section("Seaded", [
        note("Kütte ja boileri lülitid on eraldi lehel, et neile kogemata pihta ei läheks."),
        tile("switch.space_heating_climate_control", "Soojuspumba seaded", icon="mdi:tune", hide_state=True, tap_action={"action": "navigate", "navigation_path": "/lovelace/soojuspump-seaded"}, icon_tap_action={"action": "navigate", "navigation_path": "/lovelace/soojuspump-seaded"}, grid_options={"columns": "full", "rows": 1}),
    ]),
    section("Küte", [
        note("Põrandaküte. Kui küte töötab, näitab graafik küttekõverat: mida külmem väljas, seda soojem küttevesi. Ruumitermostaati pumbal pole."),
        tile("sensor.space_heating_leaving_water_temperature", "Küttevee temp", features=[{"type": "trend-graph", "hours_to_show": 24}]),
        tile("sensor.space_heating_outdoor_temperature", "Väljas (pumba andur)", features=[{"type": "trend-graph", "hours_to_show": 24}]),
        when_on("binary_sensor.space_heating_unit_state", "Soojuspumba viga"),
        hist("Küttevesi ja välistemperatuur 48 h", [("sensor.space_heating_leaving_water_temperature", "Küttevesi"),
                                                    ("sensor.space_heating_outdoor_temperature", "Väljas")], 48),
    ]),
    section("Soe vesi", [
        note("180 l paak, siht 55 °C. Graafikul on näha, millal pump paaki soojendab (järsk tõus) ja kuidas tarbimine seda tühjendab (langus). See on faasi 6 automaatika alusmaterjal."),
        tile("sensor.boileri_vee_temperatuur", "Vee temperatuur", color="blue"),
        when_on("binary_sensor.hot_water_tank_state", "Boileri viga"),
        hist("Boileri vee temperatuur 48 h", [("sensor.boileri_vee_temperatuur", "Boileri vesi")], 48),
    ]),
    section("Sooja vee energia", [
        note("Soojuspumba elekter sooja vee jaoks Daikini enda loenduri järgi, täis-kWh sammuga. Kütte loendur on seadmel katki, seetõttu kütte kWh-numbreid siin ei ole."),
        tile("sensor.boiler_energy_today", "Täna"),
        tile("sensor.boiler_energy_month", "Sel kuul"),
        daikin_bars("Boiler päevas, kWh (2 nädalat)", "sensor.boiler_energy_today", "15d", "day", DAYS_JS, {"day": "dd.MM"}),
        daikin_bars("Boiler kuus, kWh (2 aastat)", "sensor.boiler_energy_month", "731d", "month", MONTHS_JS, {"month": "MMM yy", "year": "yyyy"}),
    ]),
]}

ventilatsioon = {"title": "Ventilatsioon", "path": "ventilatsioon", "icon": "mdi:fan", "type": "sections", "max_columns": 2,
 # Same shape as Kodu: one row of vertical tiles per section, a chart only where the number moves, no captions.
 # Mode and ECO ride as badges; the settings subview is a badge too, so the view has no card that is only a link.
 "badges": [
    {"type": "entity", "entity": MODE, "name": "Režiim", "show_name": True, "show_state": True},
    {"type": "entity", "entity": "switch.komfovent_eco_mode", "name": "ECO", "show_name": True, "show_state": True},
    {"type": "entity", "entity": MODE, "name": "Seaded", "icon": "mdi:tune", "show_name": True, "show_state": False,
     "tap_action": {"action": "navigate", "navigation_path": "/lovelace/komfovent-seaded"}},
 ],
 "sections": [
    section("Õhk", [
        {"type": "horizontal-stack", "cards": [
            nowrite("sensor.komfovent_supply_temperature", "Sissepuhe", vertical=True),
            nowrite("sensor.komfovent_extract_temperature", "Väljatõmme", vertical=True),
            nowrite("sensor.komfovent_outdoor_temperature", "Välisõhk", vertical=True),
            nowrite("sensor.komfovent_panel_1_humidity", "Niiskus", vertical=True)]},
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
            nowrite("sensor.ventilatsioon_sel_kuul", "Sel kuul", vertical=True),
            nowrite("sensor.jarelkute_sel_kuul", "Järelküte sel kuul", color="red", vertical=True)]},
        bars("Seade päevas, kWh", [("sensor.komfovent_total_ahu_energy", "Seade")], 31),
    ]),
]}

susteem = {"title": "Süsteem", "path": "susteem", "icon": "mdi:home-assistant", "type": "sections", "subview": True, "max_columns": 2, "sections": [
    section("Uuendused", [
        note("HACS-i kaudu paigaldatud integratsioonid ja kaardid. Kodu vaates paistab see loend ainult siis, kui mõni uuendus ootab. HA enda uuendus käib repo kaudu Renovate'iga."),
        {"type": "entities", "entities": UPDATES},
    ]),
    section("Telefon", [
        note("Companion äpi andurid. Kui need on \"pole saadaval\", ei ole äpp taustal andmeid saatnud: ava äpp või kontrolli Seaded → Kaasrakendus → Andurite haldus. Asukoht töötab eraldi ja on korras."),
        tile("person.owner", "Kaido"),
        tile("sensor.phone_battery_level", "Aku"),
        tile("sensor.phone_battery_state", "Laadimine"),
        tile("sensor.phone_connection_type", "Ühendus"),
        tile("sensor.phone_ssid", "Wifi"),
    ]),
    section("Salvestus ja varundus", [
        note("HA salvesti hoiab 30 päeva olekuid, statistika jääb igavesti. Varundus käib homelabi backup.sh-ga igal öösel (konf + salvesti koopia), mitte HA enda varundusega, seetõttu on HA varundusandurid kinni."),
        tile("sensor.nvr_ketas", "NVR ketas"),
    ]),
    section("Kaamerate põhivood", [
        note("Täisresolutsiooni otsepilt, käivitub aeglaselt. Igapäevaseks vaatamiseks on Valve tabi alamvood."),
    ] + [tile("camera." + slug, n) for slug, n in CAMS]),
    section("Nord Pool toorandmed", [
        note("Börsi 15-minuti hinnad ilma tasudeta ja koguhind 15-minuti sammuga. Kodu vaade kasutab tunni keskmisi, sest arvesti loeb tunni kaupa."),
        tile("sensor.nord_pool_ee_praegune_hind", "Börs praegu"),
        tile("sensor.nord_pool_ee_jargmine_hind", "Börs järgmine"),
        tile("sensor.elektri_hind_kokku", "Kokku, 15 min"),
        tile(FORECAST, "Prognoos katab"),
    ]),
]}

def mode_row(key, timer=False):
    """One mode's settings as a row of vertical tiles: fans, setpoint, heater flag, optional timer. Taps open more-info to edit."""
    # Short names: five vertical tiles in a row truncate "Sissepuhe %" on a phone, and the value already carries the unit.
    cards = [tile(f"number.komfovent_{key}_supply_flow", "Sisse", vertical=True),
             tile(f"number.komfovent_{key}_extract_flow", "Välja", vertical=True),
             tile(f"number.komfovent_{key}_temperature", "Sihttemp", vertical=True),
             confirm(f"switch.komfovent_{key}_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red", vertical=True)]
    if timer: cards.append(tile(f"number.komfovent_{key}_timer", "Kestus min", vertical=True))
    return {"type": "horizontal-stack", "cards": cards}

komfovent_seaded = {"title": "Ventilatsiooni seaded", "path": "komfovent-seaded", "icon": "mdi:tune", "type": "sections", "subview": True, "max_columns": 3, "sections": [
    section("Juhtimine", [
        tile(MODE, "Režiim", features=[{"type": "select-options"}]),
        tile("select.komfovent_scheduler_mode", "Ajakava", features=[{"type": "select-options"}]),
        tile("switch.komfovent_auto_mode", "Automaatrežiim"),
        confirm("switch.komfovent_power", "Seade sees", "Lülitad kogu ventilatsiooni. Kindel?"),
    ]),
    # ECO is the strategy since 2026-09-13: heater blocked, exchanger always on. Free cooling is the one seasonal switch
    # (on in late spring for night cooling, off in autumn). The heat-recovery select writes fine but the integration
    # cannot read that register back, so its tile is always blank; the name says so.
    section("ECO", [
        tile("switch.komfovent_eco_mode", "ECO sees"),
        confirm("switch.komfovent_eco_heater_blocking", "Kütteblokeering", "Väljalülitamine lubab elektrilise järelkütte. Kindel?", color="red"),
        confirm("switch.komfovent_eco_free_heating_cooling", "Suvine vaba jahutus", "Sees: soojusvaheti seisab, kui välisõhk on toast jahedam. Talvel peab olema väljas. Kindel?"),
        tile("select.komfovent_eco_heat_recovery", "Soojustagastus"),  # reads back as unknown; tap opens more-info where the option can still be set
        tile("number.komfovent_eco_min_supply_temperature", "Min sissepuhe"),
        tile("number.komfovent_eco_max_supply_temperature", "Max sissepuhe"),
    ]),
    section("Tavaline", [mode_row("normal")]),
    section("Köök", [mode_row("kitchen", timer=True)]),
    section("Kamin", [mode_row("fireplace", timer=True)]),
    section("Eemal", [mode_row("away")]),
    section("Harva kasutatavad režiimid",
        [note("Intensiivne"), mode_row("intensive"), note("Boost"), mode_row("boost"), note("Override"), mode_row("override", timer=True),
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
    section("Juhtimine", [
        note("Küttevee nihe on faasi 6 hoob: +1 kraad nihutab küttekõverat üles, -1 alla. Boileri siht 55 °C; mitte alla 45 °C (legionella). Ohtlikud lülitid küsivad kinnitust."),
        confirm("switch.space_heating_climate_control", "Küte", "Lülitad maja kütte. Kindel?"),
        tile("number.space_heating_temperature_control", "Küttevee nihe", features=[{"type": "numeric-input", "style": "buttons"}]),
        tile("select.space_heating_operation_mode", "Kütte režiim", features=[{"type": "select-options"}]),
        tile("water_heater.hot_water_tank_domestic_hot_water_tank", "Boiler", state_content=["state", "temperature"],
             features=[{"type": "target-temperature"}]),
    ]),
]}

config = {"title": "Kodu", "views": [home, energy, soojuspump, ventilatsioon, cameras, lights, susteem, komfovent_seaded, soojuspump_seaded]}

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
        v = r["result"]["views"]; print("views:", [x["title"] for x in v], "| cards:", sum(len(c["cards"]) for x in v for c in x["sections"]))
asyncio.run(main())
