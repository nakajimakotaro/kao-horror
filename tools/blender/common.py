"""Shared helpers for the procedural Blender asset scripts (Blender 5.x, run headless).

Everything here uses THREE.JS COORDINATES so the numbers match src/world/catalog.json:
    x = right, y = up, z = toward the viewer (the model's FRONT faces +z)
They are converted to Blender's Z-up space internally:
    three (x, y, z)  ->  blender (x, -z, y)
Sizes are (w, h, d) = (x extent, y extent, z extent) in three terms.

Typical model script:

    from common import *
    def build():
        body = box("body", (0.6, 1.5, 0.65), (0, 0.75, 0), mat("fridge_white", "#d8d8d4", 0.4))
        door = box("door", (0.6, 1.0, 0.04), (0, 1.0, 0.345), mat("fridge_white"))
        set_origin(door, (0.30, 1.0, 0.325))       # hinge
        ...
    run_model("fridge", build)

run_model() wipes the scene, calls build(), and exports public/models/<id>.glb.
Objects whose names match catalog "parts"/"nodes" must keep exactly those names
(they are found by name in three.js); everything else may be named freely.
"""
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(ROOT, "public", "models")
PREVIEW_DIR = os.path.join(ROOT, "tools", "blender", "previews")


# ── coordinates ────────────────────────────────────────────────────────────
def T(x, y, z):
    """three.js point -> Blender Vector"""
    return Vector((x, -z, y))


def TS(w, h, d):
    """three.js size -> Blender dimensions"""
    return Vector((w, d, h))


# ── scene ──────────────────────────────────────────────────────────────────
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for c in list(bpy.data.collections):
        bpy.data.collections.remove(c)
    _MATS.clear()


def _link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ── materials ──────────────────────────────────────────────────────────────
_MATS = {}


def _srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (_srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b), 1.0)


def mat(name, color="#bbbbbb", rough=0.8, metal=0.0, emit=None, emit_strength=1.0, alpha=None):
    """Get or create a Principled material. Calling again with the same name returns the cached one.

    Naming rules (three.js side): tex_<id> gets a texture, emit_<id> glows (set `emit`), glass / glass_frosted
    become transparent, mirror / water / screen_<id> get special looks.
    """
    if name in _MATS:
        return _MATS[name]
    m = bpy.data.materials.new(name)
    nt = m.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.get("Material Output") or nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs["Base Color"].default_value = hexcol(color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = hexcol(emit)
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    if alpha is not None:
        bsdf.inputs["Alpha"].default_value = alpha
    m.diffuse_color = hexcol(color)
    _MATS[name] = m
    return m


# ── primitives (all positions/sizes in three.js terms) ─────────────────────
def _finish(obj, material, parent):
    if material is not None:
        obj.data.materials.clear()
        obj.data.materials.append(material)
    if parent is not None:
        set_parent(obj, parent)
    return obj


def box(name, size, pos, material=None, bevel=0.0, parent=None):
    """Axis aligned box centered at pos."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    s = TS(*size)
    for v in me.vertices:
        v.co = Vector((v.co.x * s.x, v.co.y * s.y, v.co.z * s.z))
    obj.location = T(*pos)
    if bevel > 0:
        apply_bevel(obj, bevel)
    return _finish(obj, material, parent)


def cyl(name, radius, height, pos, material=None, verts=12, axis="y", radius2=None, parent=None, cap=True):
    """Cylinder (or cone/frustum with radius2) centered at pos; axis in three terms: 'x', 'y' or 'z'."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=verts,
                          radius1=radius, radius2=radius if radius2 is None else radius2, depth=height)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    # created along Blender Z (= three Y)
    if axis == "x":
        obj.rotation_euler = (0, math.pi / 2, 0)
    elif axis == "z":
        obj.rotation_euler = (math.pi / 2, 0, 0)
    obj.location = T(*pos)
    apply_transform(obj, location=False)
    return _finish(obj, material, parent)


def sphere(name, radius, pos, material=None, segs=12, rings=8, scale=(1, 1, 1), parent=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=radius)
    bm.to_mesh(me)
    bm.free()
    obj = _link(bpy.data.objects.new(name, me))
    s = TS(*scale)
    for v in me.vertices:
        v.co = Vector((v.co.x * s.x, v.co.y * s.y, v.co.z * s.z))
    obj.location = T(*pos)
    return _finish(obj, material, parent)


def plane(name, w, h, pos, material=None, facing="z", parent=None):
    """Flat rectangle w x h facing +z (default), +x, -x, -z or +y (lying, facing up). UVs 0..1, upright."""
    me = bpy.data.meshes.new(name)
    hw, hh = w / 2, h / 2
    if facing in ("z", "-z"):
        sgn = 1 if facing == "z" else -1
        verts = [T(-hw * sgn, -hh, 0), T(hw * sgn, -hh, 0), T(hw * sgn, hh, 0), T(-hw * sgn, hh, 0)]
    elif facing in ("x", "-x"):
        sgn = 1 if facing == "x" else -1
        verts = [T(0, -hh, hw * sgn), T(0, -hh, -hw * sgn), T(0, hh, -hw * sgn), T(0, hh, hw * sgn)]
    else:  # 'y' lying flat facing up; h runs along -z (away from viewer)
        verts = [T(-hw, 0, hh), T(hw, 0, hh), T(hw, 0, -hh), T(-hw, 0, -hh)]
    me.from_pydata([tuple(v) for v in verts], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new(name="UVMap")
    for i, co in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = co
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = T(*pos)
    return _finish(obj, material, parent)


def mesh_from(name, verts3, faces, material=None, parent=None, pos=(0, 0, 0)):
    """Arbitrary mesh from three.js-space vertices and faces (CCW seen from outside)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(T(*v)) for v in verts3], [], faces)
    me.update()
    obj = _link(bpy.data.objects.new(name, me))
    obj.location = T(*pos)
    return _finish(obj, material, parent)


def empty(name, pos, parent=None):
    obj = _link(bpy.data.objects.new(name, None))
    obj.empty_display_size = 0.05
    obj.location = T(*pos)
    if parent is not None:
        set_parent(obj, parent)
    return obj


def group(name, pos=(0, 0, 0)):
    """An empty used as an animated part / grouping node; parent pieces to it."""
    return empty(name, pos)


# ── transforms ─────────────────────────────────────────────────────────────
def apply_transform(obj, location=True, rotation=True, scale=True):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)


def apply_bevel(obj, width, segments=1):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def update():
    """Refresh matrix_world after changing locations (Blender updates them lazily)."""
    bpy.context.view_layer.update()


def set_origin(obj, pos):
    """Move the object's origin (pivot) to a three.js point without moving the geometry."""
    update()
    world = T(*pos)
    mw = obj.matrix_world.copy()
    local = mw.inverted() @ world
    if obj.type == "MESH":
        obj.data.transform(Matrix.Translation(-local))
    for ch in obj.children:
        ch.matrix_parent_inverse = Matrix.Translation(-local) @ ch.matrix_parent_inverse
    obj.matrix_world = mw @ Matrix.Translation(local)


def set_parent(child, parent):
    update()
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw


def rotate(obj, deg, axis="y"):
    """Rotate about a three.js axis around the object's origin."""
    ax = {"x": (1, 0, 0), "y": (0, 0, 1), "z": (0, -1, 0)}[axis]
    update()
    obj.rotation_mode = "XYZ"
    obj.matrix_world = obj.matrix_world @ Matrix.Rotation(math.radians(deg), 4, Vector(ax))


def join(objs, name):
    """Join meshes into one object (keeps materials)."""
    objs = [o for o in objs if o is not None and o.type == "MESH"]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def shade_flat(obj):
    for p in obj.data.polygons:
        p.use_smooth = False


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


def array_x(src, count, step, name=None):
    """Duplicate an object along three.js x. Returns the list including src."""
    out = [src]
    for i in range(1, count):
        o = src.copy()
        o.data = src.data.copy()
        o.location = src.location + Vector((step * i, 0, 0))
        _link(o)
        if name:
            o.name = f"{name}_{i}"
        out.append(o)
    return out


def dup(src, offset=(0, 0, 0), name=None):
    update()
    o = src.copy()
    o.data = src.data.copy() if src.data else None
    o.location = src.location + T(*offset)
    _link(o)
    if name:
        o.name = name
    if src.parent:
        o.parent = src.parent
        o.matrix_parent_inverse = src.matrix_parent_inverse.copy()
    return o


# ── export ─────────────────────────────────────────────────────────────────
def export_glb(model_id):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, f"{model_id}.glb")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
    )
    return path


def scene_stats():
    tris = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    return tris


def bounds_three():
    """World bounds of all meshes in three.js coords: (min(x,y,z), max(x,y,z))."""
    update()
    mn = [1e9] * 3
    mx = [-1e9] * 3
    for o in bpy.context.scene.objects:
        if o.type != "MESH":
            continue
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            p = (w.x, w.z, -w.y)
            for i in range(3):
                mn[i] = min(mn[i], p[i])
                mx[i] = max(mx[i], p[i])
    return mn, mx


def render_preview(model_id, size=420):
    """Quick Workbench render (front-right, slightly above) to tools/blender/previews/<id>.png."""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scn = bpy.context.scene
    mn, mx = bounds_three()
    cx, cy, cz = [(mn[i] + mx[i]) / 2 for i in range(3)]
    ext = max(mx[i] - mn[i] for i in range(3)) or 1.0
    cam_data = bpy.data.cameras.new("pcam")
    cam = bpy.data.objects.new("pcam", cam_data)
    scn.collection.objects.link(cam)
    eye = T(cx + ext * 1.1, cy + ext * 0.75, cz + ext * 1.6)
    target = T(cx, cy, cz)
    d = target - eye
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.location = eye
    cam_data.lens = 40
    scn.camera = cam
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "STUDIO"
    scn.display.shading.color_type = "MATERIAL"
    scn.render.resolution_x = size
    scn.render.resolution_y = size
    scn.render.film_transparent = False
    scn.render.filepath = os.path.join(PREVIEW_DIR, f"{model_id}.png")
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def run_model(model_id, build, preview=None):
    """Reset, build, report, export (and optionally render a preview PNG)."""
    reset()
    build()
    mn, mx = bounds_three()
    size = [round(mx[i] - mn[i], 3) for i in range(3)]
    path = export_glb(model_id)
    want_preview = preview if preview is not None else ("--preview" in sys.argv)
    if want_preview:
        render_preview(model_id)
    names = sorted(o.name for o in bpy.context.scene.objects)
    print(f"[model] {model_id}: tris={scene_stats()} size(w,h,d)={size} min={[round(v, 3) for v in mn]} -> {os.path.relpath(path, ROOT)}")
    print(f"[nodes] {model_id}: {names[:40]}{' …' if len(names) > 40 else ''}")


def only_requested(model_id):
    """Allow `-- --only fridge,toilet` to rebuild a subset."""
    if "--only" in sys.argv:
        i = sys.argv.index("--only")
        if i + 1 < len(sys.argv):
            return model_id in sys.argv[i + 1].split(",")
    return True
