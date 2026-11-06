import copy, json, pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import kicad_review as k
sample = pathlib.Path("ui/sample/review-data.js").read_text()
data = json.loads(sample[sample.index("{"):sample.rindex("}")+1])
scene = k.board_geometry("ui/fixtures/vf-order-4.kicad_pcb")
# Derived fixture keeps real physical stack and adds same-layer overlaps to expose per-path attenuation.
for obj in list(scene["objects"]):
    if obj.get("kind") == "track":
        dup = copy.deepcopy(obj); dup["uuid"] += "-overlap"; dup["geometry"]["segments"] = [[8000,5000,12000,5000,2000]]; dup["box"]=k.geometry_box(dup["geometry"]); scene["objects"].append(dup)
scene["nets"].append({"id": 1, "name": "12"})
for obj in scene["objects"]: obj["net"] = 1
base = copy.deepcopy(scene); base["nets"][1]["name"] = "REMOVED"
blobs = data.setdefault("blobs", {})
board = data["projects"][0]["board"]
board["geometry"]={side:k.add_blob(blobs,json.dumps(sc)) for side,sc in (("base",base),("head",scene))}
# Match the report's SVG layer-eye metadata to the replacement geometry, not the two-layer sample.
layer_svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm" viewBox="0 0 20 10"><path d="M2 5H18" stroke="red" stroke-width="2" fill="none"/></svg>'
layer_blob = k.add_blob(blobs, layer_svg)
board["size"] = k.svg_size(layer_svg)
board["layers"] = [{"name": layer["name"].replace(".", "_"), "changed": False,
                    "svg": {"base": layer_blob, "head": layer_blob}}
                   for layer in scene["layers"] if layer["enabled"]]
assert {layer["name"] for layer in board["layers"]} == {"F_Cu", "In1_Cu", "In2_Cu", "B_Cu"}
data["settings"]["ask"]={"enabled":True}
pathlib.Path(sys.argv[1]).write_text(k.inline_page("window.REVIEW_DATA = "+json.dumps(data)+";"))
