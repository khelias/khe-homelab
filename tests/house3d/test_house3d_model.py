"""Tests for scripts/house3d_model.py and scripts/house3d-build.py, on the synthetic fixture.

Run from the repo root: python3 -I -m unittest discover -s tests/house3d -v
"""
import copy, importlib.util, json, shutil, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/house3d/fixture-model.md"
ENGINE = ROOT / "services/home/homeassistant/house3d"
BUILD = ROOT / "scripts/house3d-build.py"

_spec = importlib.util.spec_from_file_location("house3d_model", ROOT / "scripts/house3d_model.py")
hm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hm)


def layers():
    return hm.read_layers(FIXTURE)


def run(*args):
    return subprocess.run([sys.executable, "-I", str(BUILD), *map(str, args)], capture_output=True, text=True)


class FixtureModel(unittest.TestCase):
    def test_fixture_validates(self):
        self.assertEqual(hm.validate(layers()), [])

    def test_merge_is_a_union_of_keys(self):
        L = layers()
        model = hm.merge(L, hm.LAYERS)
        for name, layer in L.items():
            for key in layer:
                self.assertIn(key, model)
        self.assertNotIn("devices", hm.merge(L, hm.PUBLIC))

    def test_with_room_names_replaces_neutral_names(self):
        L = layers()
        model = hm.with_room_names(hm.merge(L, hm.LAYERS))
        names = {r["id"]: r["name"] for r in model["rooms"]}
        self.assertEqual(names["r1"], L["private"]["room_names"]["r1"])
        self.assertEqual(names["r2"], L["private"]["room_names"]["r2"])
        self.assertEqual(names["carport"], "Varjualune")
        self.assertNotIn("room_names", model)
        # the shareable rooms layer keeps its neutral names
        self.assertEqual(L["rooms"]["rooms"][0]["name"], "Elutuba")

    def test_private_strings(self):
        L = layers()
        out = hm.private_strings(hm.merge(L, hm.LAYERS))
        for d in L["private"]["devices"]:
            self.assertIn(d["entity"], out)
            self.assertIn(d["name"], out)
        for name in L["private"]["room_names"].values():
            self.assertIn(name, out)
        self.assertIn(L["private"]["car"]["entity"], out)
        self.assertIn(L["private"]["car"]["name"], out)


def _walls(L):
    return L["geometry"]["walls"]


def _gr(L):
    return L["geometry"]["site"]["garage_roof"]


def _no_sill(L):
    del _walls(L)[0]["openings"][0]["sill"]


def _bad_kind(L):
    _walls(L)[0]["openings"][0]["kind"] = "hatch"


def _both(L):
    _gr(L)["rect"] = [12.8, 0.8, 17.2, 7.2]


def _neither(L):
    del _gr(L)["rects"]


def _empty(L):
    _gr(L)["rects"] = []


def _three(L):
    _gr(L)["rects"][0] = [12.8, 0.8, 17.2]


def _y_reversed(L):
    _gr(L)["y"] = [2.8, 2.6]


def _x_reversed(L):
    _gr(L)["rects"][1] = [14, 7.2, 12.8, 9]


def _no_private(L):
    del L["private"]


def _twice(L):
    L["rooms"]["ceiling"] = 2.6


def _bad_finish(L):
    _walls(L)[6]["finish"] = "brick"


def _bad_floor(L):
    L["rooms"]["rooms"][0]["floor"] = "carpet"


def _short_path(L):
    L["private"]["car"]["path"][0] = [15.137, -7.137]


def _site(L):
    return L["geometry"]["site"]


def _bar_fence_point(L):
    _site(L)["bar_fences"][0] = [[0, -6]]


def _trampoline_flat(L):
    _site(L)["trampoline"]["height"] = 0


def _trampoline_rect(L):
    _site(L)["trampoline"]["rect"] = [10, 12, 8, 13]


def _slide_three(L):
    _site(L)["swing"]["slide"] = [1, 2, 3]


def _planter_y(L):
    _site(L)["planters"][0]["y"] = [0.5, 0]


def _planter_plant(L):
    _site(L)["planters"][0]["plant"] = "palm"


def _planter_finish(L):
    _site(L)["planters"][1]["finish"] = "brick"


def _step_height(L):
    _site(L)["steps"][0]["height"] = -0.1


def _planter_list(L):
    _site(L)["planters"][0] = [11, -1, 11.6, -0.4]


def _step_rect(L):
    _site(L)["steps"][0]["rect"] = [11, 1.3, 10, 1.8]


MUTATIONS = [
    ("window without sill", _no_sill, "a window needs a sill"),
    ("unknown opening kind", _bad_kind, "is not window, door or glassdoor"),
    ("garage_roof with rect and rects", _both, "site.garage_roof: needs either rect or rects"),
    ("garage_roof with neither", _neither, "site.garage_roof: needs either rect or rects"),
    ("garage_roof with empty rects", _empty, "site.garage_roof.rects: not a non-empty list"),
    ("garage_roof rect of three numbers", _three, "site.garage_roof.rects[0]: rect"),
    ("garage_roof y reversed", _y_reversed, "site.garage_roof: y must be [y0, y1]"),
    ("rect with x0 > x1", _x_reversed, "site.garage_roof.rects[1]: rect"),
    ("private layer missing", _no_private, "layer private is missing"),
    ("key in two layers", _twice, "key ceiling is in more than one layer"),
    ("car path does not clear the drive gate", _short_path, "car: path starts"),
    ("unknown wall finish", _bad_finish, "walls[6]: finish 'brick' is not panel"),
    ("unknown floor finish", _bad_floor, "room r1: floor 'carpet' is not one of tile, paving"),
    ("bar fence of one point", _bar_fence_point, "site.bar_fences[0]: must be [[x, z], [x, z]]"),
    ("trampoline without height", _trampoline_flat, "site.trampoline: height is not a positive number"),
    ("trampoline rect reversed", _trampoline_rect, "site.trampoline: rect"),
    ("slide of three numbers", _slide_three, "site.swing: slide must be [x, z]"),
    ("planter y reversed", _planter_y, "site.planters[0]: y must be [y0, y1]"),
    ("unknown plant", _planter_plant, "site.planters[0]: plant 'palm' is not one of thuja, low"),
    ("unknown planter finish", _planter_finish, "site.planters[1]: finish 'brick' is not one of frame, cladding"),
    ("step without height", _step_height, "site.steps[0]: height is not a positive number"),
    ("planter not an object", _planter_list, "site.planters[0]: not a JSON object"),
    ("step rect reversed", _step_rect, "site.steps[0]: rect"),
]


class Mutations(unittest.TestCase):
    def test_each_mutation_reports_its_problem(self):
        base = layers()
        for name, mutate, problem in MUTATIONS:
            with self.subTest(name):
                L = copy.deepcopy(base)
                mutate(L)
                problems = hm.validate(L)
                self.assertTrue(any(problem in p for p in problems), f"{problem!r} not in {problems}")


class BuildAndScan(unittest.TestCase):
    def test_build_keeps_the_bearing_and_leaves_out_georef_and_devices(self):
        with tempfile.TemporaryDirectory() as tmp:
            r = run(FIXTURE, tmp)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            model = json.loads((Path(tmp) / "model.json").read_text(encoding="utf-8"))
            self.assertNotIn("georef", model)
            self.assertEqual(model["orientation"], {"x_axis_bearing_deg": 30})
            self.assertNotIn("devices", model)
            self.assertNotIn("car", model)
            self.assertNotIn("surroundings", model)

    def test_scan_of_the_engine_is_clean(self):
        r = run("--scan", FIXTURE, ENGINE)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_scan_finds_an_entity_id(self):
        entity = layers()["private"]["devices"][0]["entity"]
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "house3d.js"
            shutil.copyfile(ENGINE / "house3d.js", f)
            with f.open("a", encoding="utf-8") as out:
                out.write(f"\n// {entity}\n")
            r = run("--scan", FIXTURE, f)
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertIn(f"private string {entity!r}", r.stdout)


if __name__ == "__main__":
    unittest.main()
