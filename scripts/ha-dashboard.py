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
CAMS = [("lasteaed", "Lasteaed"), ("oue", "Õue"), ("naabrid", "Naabrid"), ("tee", "Tee"), ("ouemaja", "Õuemaja")]
FORECAST = "sensor.elektri_hinna_prognoos"
# Presence badges render "<name> <state>", so the verb rides in the name ("Kaido on" -> "Kaido on Kodus").
# Family members are read from an untracked local file (this repo is public): a JSON list of [entity_id, label].
_people_file = os.path.expanduser("~/.config/khe/ha-people.json")
PEOPLE = json.load(open(_people_file)) if os.path.exists(_people_file) else [("person.kaido_henrik_elias", "Kaido on")]  # badge renders "<name> <state>"
UPDATES = ["update.hacs_update", "update.komfovent_update", "update.daikin_altherma_update", "update.hikvision_nvr_ip_camera_update", "update.apexcharts_card_update"]

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
def mode_button(name, icon, option, color=None):
    c = {"type": "button", "name": name, "icon": icon, "show_state": False,
         "tap_action": {"action": "perform-action", "perform_action": "select.select_option",
                        "target": {"entity_id": MODE}, "data": {"option": option},
                        "confirmation": {"text": f"Ventilatsioon režiimile {name}?"}},
         "grid_options": {"columns": 3, "rows": 1}}
    if color: c["icon_color"] = color
    return c

def note(text):
    return {"type": "heading", "heading": text, "heading_style": "subtitle"}
def bars(title, ents, days, stat="change"):
    return {"type": "statistics-graph", "title": title, "chart_type": "bar", "period": "day", "days_to_show": days,
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
    section("Ilm", [
        {"type": "weather-forecast", "entity": "weather.forecast_kodu", "forecast_type": "hourly", "show_current": True, "show_forecast": True, "round_temperature": True},
    ]),
    section("Elekter", [
        {"type": "glance", "columns": 3, "show_icon": False, "show_name": True, "show_state": True,
         "entities": [{"entity": "sensor.elektri_hind_eelmine_tund", "name": "Eelmine tund"},
                      {"entity": "sensor.elektri_hind_see_tund", "name": "See tund"},
                      {"entity": "sensor.elektri_hind_jargmine_tund", "name": "Järgmine tund"}]},
        price_chart,
    ], badges=[{"type": "entity", "entity": "binary_sensor.nord_pool_ee_homne_hind_on_saadaval", "name": "Homne hind olemas", "state_content": "name",
                "visibility": [{"condition": "state", "entity": "binary_sensor.nord_pool_ee_homne_hind_on_saadaval", "state": "on"}]}],
       **nav("/lovelace/energia")),
    section("Küte", [
        nowrite("switch.space_heating_climate_control", "Küte (Daikin)"),
        tile("sensor.space_heating_leaving_water_temperature", "Küttevee temp"),
        when_on("binary_sensor.space_heating_unit_state", "Soojuspumba viga"),
    ], **nav("/lovelace/soojuspump")),
    section("Soe vesi", [
        nowrite("water_heater.hot_water_tank_domestic_hot_water_tank", "Boiler", state_content=["state", "temperature"]),
        nowrite("water_heater.hot_water_tank_domestic_hot_water_tank", "Vee temperatuur", icon="mdi:thermometer-water", color="blue", state_content=["current_temperature"]),
        when_on("binary_sensor.hot_water_tank_state", "Boileri viga"),
    ], **nav("/lovelace/soojuspump")),
    section("Ventilatsioon", [
        mode_button("Köök", "mdi:stove", "kitchen", "orange"),
        mode_button("Intensiivne", "mdi:fan-plus", "intensive", "blue"),
        mode_button("Eemal", "mdi:home-export-outline", "away", "grey"),
        mode_button("Tavaline", "mdi:fan", "normal", "green"),
        tile("sensor.komfovent_supply_temperature", "Sissepuhe"),
        tile("sensor.komfovent_extract_temperature", "Väljatõmme"),
        tile("sensor.komfovent_panel_1_humidity", "Niiskus"),
        when_on("binary_sensor.komfovent_status_alarm_fault", "Ventilatsiooni viga"),
        when_on("binary_sensor.komfovent_status_alarm_warning", "Ventilatsiooni hoiatus"),
    ], badges=[{"type": "entity", "entity": MODE, "name": "Režiim", "show_state": True}], **nav("/lovelace/ventilatsioon")),
    section("Süsteem", [
        {"type": "entities", "title": "Uuendused", "entities": UPDATES,
         "visibility": [{"condition": "or", "conditions": [{"condition": "state", "entity": u, "state": "on"} for u in UPDATES]}]},
        tile("sensor.nvr_ketas", "NVR ketas", color="red", visibility=[{"condition": "state", "entity": "sensor.nvr_ketas", "state_not": "OK"}]),
        tile("sensor.kaido_henriks_iphone_battery_level", "Telefoni aku", color="red",
             visibility=[{"condition": "numeric_state", "entity": "sensor.kaido_henriks_iphone_battery_level", "below": 30}]),
        {"type": "markdown", "content": "Kõik korras.",
         "visibility": [{"condition": "and", "conditions": [{"condition": "state", "entity": "sensor.nvr_ketas", "state": "OK"}] +
                         [{"condition": "state", "entity": u, "state_not": "on"} for u in UPDATES]}]},
    ], **nav("/lovelace/susteem")),
]}

energy = {"title": "Energia", "path": "energia", "icon": "mdi:lightning-bolt", "type": "sections", "max_columns": 2, "sections": [
    section("Mis elekter maksab", [
        note("Koguhind tunni kaupa koos võrgutasu ja käibemaksuga, viimased 7 päeva."),
        hist("Koguhind 7 päeva, €/kWh", [("sensor.elektri_hind_see_tund", "Kokku")], 168),
        third(tile("sensor.nord_pool_ee_madalaim_hind", "Börsi madalaim täna", vertical=True, color="green")),
        third(tile("sensor.nord_pool_ee_korgeim_hind", "Börsi kõrgeim täna", vertical=True, color="red")),
        third(tile("binary_sensor.vorgu_ootariif", "Öötariif", vertical=True)),
    ]),
    section("Kui palju maja tarbib", [
        note("Elektrilevi tunnitarbimine, imporditud CSV-st. Uueneb ainult uue ekspordiga. Kuu ja aasta summad on külgriba Energia töölaual."),
        bars("Tarbimine päevas, kWh", [("elektrilevi:grid_consumption", "kWh")], 31),
        bars("Kulu päevas, € (ilma kuutasudeta)", [("elektrilevi:grid_cost", "€")], 31),
    ]),
    section("Suuremad tarbijad sel kuul", [
        note("Seadmete oma loendurid kuu algusest. Maja kokku on ülal Elektrilevi tulpades. Plaat viib seadme tabile."),
        tile("sensor.boiler_energy_month", "Boiler", **nav("/lovelace/soojuspump")),
        tile("sensor.ventilatsioon_sel_kuul", "Ventilatsioon", **nav("/lovelace/ventilatsioon")),
        tile("sensor.jarelkute_sel_kuul", "Järelküte", color="red", **nav("/lovelace/ventilatsioon")),
    ]),
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
         "tap_action": {"action": "url", "url_path": "http://192.168.0.129/"}},
    ]),
    section("Liikumistuvastus", [
        note("Kaamera kaupa sisse/välja. Tundlikkus ja tuvastusalad on NVR-i enda seadetes."),
    ] + [tile("switch." + slug + "_liikumistuvastus", n) for slug, n in CAMS]),
    section("Alarmikeskus (tuleb)", [
        note("Paradox on võrgus (192.168.0.240), aga ei ava ühtegi porti, seega IP150 võrgumoodulit tal pole. HA-sse saab ta HACS-i PAI integratsiooniga kas IP150 mooduli või jadaliidese kaudu. Siia tulevad valve olek, tsoonid ja sisse/välja lülitamine."),
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

ventilatsioon = {"title": "Ventilatsioon", "path": "ventilatsioon", "icon": "mdi:fan", "type": "sections", "max_columns": 2, "sections": [
    section("Seaded", [
        note("Režiim, lülitid ja kõik režiimide seaded on eraldi lehel, et neile kogemata pihta ei läheks. Kiirrežiimid on Kodu vaates."),
        tile(MODE, "Ventilatsiooni seaded", icon="mdi:tune", hide_state=True, tap_action={"action": "navigate", "navigation_path": "/lovelace/komfovent-seaded"}, icon_tap_action={"action": "navigate", "navigation_path": "/lovelace/komfovent-seaded"}, grid_options={"columns": "full", "rows": 1}),
    ]),
    section("Õhk", [
        note("Sissepuhe on see, mis tubadesse tuleb, väljatõmme see, mis tubadest lahkub. Suvel on sissepuhe umbes välisõhk (bypass), talvel soojusvaheti tõstab selle väljatõmbe lähedale."),
        tile("sensor.komfovent_supply_temperature", "Sissepuhe"),
        tile("sensor.komfovent_extract_temperature", "Väljatõmme"),
        tile("sensor.komfovent_outdoor_temperature", "Välisõhk"),
        tile("sensor.komfovent_panel_1_humidity", "Niiskus"),
        hist("Temperatuurid 48 h", [("sensor.komfovent_supply_temperature", "Sissepuhe"), ("sensor.komfovent_extract_temperature", "Väljatõmme"),
                                    ("sensor.komfovent_outdoor_temperature", "Välisõhk"), ("sensor.komfovent_panel_1_temperature", "Tehnoruum")], 48),
    ]),
    section("Soojusvaheti", [
        note("0 % tähendab suvist bypassi: soojust ei tagastata, sest välisõhk on piisavalt soe. Kui ööd jahenevad, hakkab vaheti tööle ja tagastus kasvab. Tagastatud kokku on seadme eluea loendur."),
        tile("sensor.komfovent_heat_exchanger", "Soojusvaheti"),
        tile("sensor.komfovent_heat_exchanger_efficiency", "Kasutegur"),
        tile("sensor.komfovent_heat_recovery", "Soojustagastus"),
        tile("sensor.komfovent_total_recovered_energy", "Tagastatud kokku"),
        hist("Soojusvaheti ja tagastus 7 päeva", [("sensor.komfovent_heat_exchanger", "Vaheti %"), ("sensor.komfovent_heat_recovery", "Tagastus W")], 168),
    ]),
    section("Ventilaatorid ja filter", [
        note("Ventilaatorid käivad tavarežiimis püsival kiirusel. Filtri saastatus kasvab aeglaselt; seade annab hoiatuse ise, kui vahetus on käes."),
        tile("sensor.komfovent_supply_fan", "Sissepuhke ventilaator"),
        tile("sensor.komfovent_extract_fan", "Väljatõmbe ventilaator"),
        tile("sensor.komfovent_filter_clogging", "Filter", features=[{"type": "bar-gauge", "min": 0, "max": 100}], features_position="inline"),
        when_on("binary_sensor.komfovent_status_flow_down", "Õhuvool alandatud"),
        when_on("binary_sensor.komfovent_status_alarm_fault", "Viga"),
        when_on("binary_sensor.komfovent_status_alarm_warning", "Hoiatus"),
        tile("sensor.komfovent_active_alarms", "Aktiivsed alarmid", color="red",
             visibility=[{"condition": "state", "entity": "sensor.komfovent_active_alarms", "state_not": ""}]),
        hist("Filtri saastatus 30 päeva, %", [("sensor.komfovent_filter_clogging", "Filter")], 720),
    ]),
    section("Energia", [
        note("Seade võtab püsivalt umbes 50 W, see on ventilaatorid. Järelküte on elektriline ja kallis: selle loendur peab suvel ja sügisel sirge püsima, talvel näitab, kui palju vaheti ei jõudnud."),
        tile("sensor.komfovent_power_consumption", "Võimsus", features=[{"type": "trend-graph", "hours_to_show": 24}]),
        tile("sensor.komfovent_heater_power", "Järelküte", color="red", features=[{"type": "trend-graph", "hours_to_show": 24}]),
        tile("sensor.ventilatsioon_sel_kuul", "Sel kuul"),
        tile("sensor.jarelkute_sel_kuul", "Järelküte sel kuul", color="red"),
        bars("Päevas, kWh", [("sensor.komfovent_total_ahu_energy", "Seade kokku"), ("sensor.komfovent_total_heater_energy", "Järelküte")], 31),
        hist("Järelkütte loendur 30 päeva, kWh (peab olema sirge)", [("sensor.komfovent_total_heater_energy", "Loendur")], 720),
    ]),
]}

susteem = {"title": "Süsteem", "path": "susteem", "icon": "mdi:home-assistant", "type": "sections", "subview": True, "max_columns": 2, "sections": [
    section("Uuendused", [
        note("HACS-i kaudu paigaldatud integratsioonid ja kaardid. Kodu vaates paistab see loend ainult siis, kui mõni uuendus ootab. HA enda uuendus käib repo kaudu Renovate'iga."),
        {"type": "entities", "entities": UPDATES},
    ]),
    section("Telefon", [
        note("Companion äpi andurid. Kui need on \"pole saadaval\", ei ole äpp taustal andmeid saatnud: ava äpp või kontrolli Seaded → Kaasrakendus → Andurite haldus. Asukoht töötab eraldi ja on korras."),
        tile("person.kaido_henrik_elias", "Kaido"),
        tile("sensor.kaido_henriks_iphone_battery_level", "Aku"),
        tile("sensor.kaido_henriks_iphone_battery_state", "Laadimine"),
        tile("sensor.kaido_henriks_iphone_connection_type", "Ühendus"),
        tile("sensor.kaido_henriks_iphone_ssid", "Wifi"),
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

komfovent_seaded = {"title": "Ventilatsiooni seaded", "path": "komfovent-seaded", "icon": "mdi:tune", "type": "sections", "subview": True, "max_columns": 3, "sections": [
    section("Juhtimine", [
        note("Režiimi vahetus otse. Köögi ja kamina kestus on siin minutites; 0 tähendab, et režiim püsib, kuni käsitsi tagasi vahetad."),
        tile(MODE, "Režiim", features=[{"type": "select-options"}]),
        tile("number.komfovent_kitchen_timer", "Köögirežiimi kestus"),
        tile("number.komfovent_fireplace_timer", "Kaminarežiimi kestus"),
        confirm("switch.komfovent_power", "Seade sees", "Lülitad kogu ventilatsiooni. Kindel?"),
        confirm("switch.komfovent_aq_electric_heater", "Järelküte lubatud", "Elektriline järelküte on kallis. Kindel?", color="red"),
        tile("switch.komfovent_auto_mode", "Automaatrežiim"),
        tile("switch.komfovent_eco_mode", "ECO"),
        tile("select.komfovent_scheduler_mode", "Ajakava", features=[{"type": "select-options"}]),
    ]),
    section("Režiimide seaded", [
        note("Iga režiimi ventilaatorite kiirus, sihttemperatuur ja kas elektriline järelküte on selles režiimis lubatud. Muuda harva ja teadlikult; järelkütte lülitid küsivad kinnitust."),
    ]),
    section("Tavaline", [
        tile("number.komfovent_normal_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_normal_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_normal_temperature", "Sihttemp"),
        confirm("switch.komfovent_normal_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
    ]),
    section("Eemal", [
        tile("number.komfovent_away_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_away_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_away_temperature", "Sihttemp"),
        confirm("switch.komfovent_away_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
    ]),
    section("Intensiivne", [
        tile("number.komfovent_intensive_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_intensive_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_intensive_temperature", "Sihttemp"),
        confirm("switch.komfovent_intensive_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
    ]),
    section("Boost", [
        tile("number.komfovent_boost_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_boost_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_boost_temperature", "Sihttemp"),
        confirm("switch.komfovent_boost_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
    ]),
    section("Köök", [
        tile("number.komfovent_kitchen_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_kitchen_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_kitchen_temperature", "Sihttemp"),
        confirm("switch.komfovent_kitchen_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
        tile("number.komfovent_kitchen_timer", "Kestus min"),
    ]),
    section("Kamin", [
        tile("number.komfovent_fireplace_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_fireplace_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_fireplace_temperature", "Sihttemp"),
        confirm("switch.komfovent_fireplace_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
        tile("number.komfovent_fireplace_timer", "Kestus min"),
    ]),
    section("Override", [
        tile("number.komfovent_override_supply_flow", "Sissepuhe %"),
        tile("number.komfovent_override_extract_flow", "Väljatõmme %"),
        tile("number.komfovent_override_temperature", "Sihttemp"),
        confirm("switch.komfovent_override_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
        tile("number.komfovent_override_timer", "Kestus min"),
        tile("number.komfovent_override_delay_start", "Viide start"),
        tile("number.komfovent_override_delay_stop", "Viide stopp"),
    ]),
    section("Puhkus", [
        tile("number.komfovent_holidays_temperature", "Sihttemp"),
        confirm("switch.komfovent_holidays_electric_heater", "Järelküte", "Järelküte selles režiimis. Kindel?", color="red"),
        tile("select.komfovent_holidays_micro_ventilation", "Mikroventilatsioon"),
    ]),
    section("ECO, õhukvaliteet ja muu", [
        tile("number.komfovent_aq_check_period", "AQ kontrolli periood"),
        tile("number.komfovent_aq_maximum_intensity", "AQ max intensiivsus"),
        tile("number.komfovent_aq_minimum_intensity", "AQ min intensiivsus"),
        tile("number.komfovent_aq_temperature_setpoint", "AQ sihttemp"),
        tile("number.komfovent_eco_max_supply_temperature", "ECO max sissepuhe"),
        tile("number.komfovent_eco_min_supply_temperature", "ECO min sissepuhe"),
        tile("select.komfovent_aq_outdoor_humidity_sensor", "AQ välisniiskuse andur"),
        tile("select.komfovent_aq_sensor_1_type", "AQ andur 1"),
        tile("select.komfovent_aq_sensor_2_type", "AQ andur 2"),
        tile("select.komfovent_control_stage_1", "Juhtaste 1"),
        tile("select.komfovent_control_stage_2", "Juhtaste 2"),
        tile("select.komfovent_control_stage_3", "Juhtaste 3"),
        tile("select.komfovent_eco_heat_recovery", "ECO soojustagastus"),
        tile("select.komfovent_external_coil_type", "Välise kalorifeeri tüüp"),
        tile("select.komfovent_flow_control", "Vooluhulga juhtimine"),
        tile("select.komfovent_temperature_control", "Temperatuuri juhtimine"),
        tile("switch.komfovent_aq_humidity_control", "AQ niiskuse juhtimine"),
        tile("switch.komfovent_aq_impurity_control", "AQ saaste juhtimine"),
        tile("switch.komfovent_eco_cooler_blocking", "ECO jahuti blokeering"),
        tile("switch.komfovent_eco_free_heating_cooling", "ECO vabaküte/-jahutus"),
        tile("switch.komfovent_eco_heater_blocking", "ECO kütteblokeering"),
    ]),
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
