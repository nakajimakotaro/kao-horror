"""Pose a rigged character (mixamo bone names) and bake the pose into plain meshes.

Used by models/characters.py for なお (tools/blender/assets/nao/nao_rig.blend: Armature + Body + HeadMesh,
weighted to "mixamorig:*" bones, Blender Z-up, front = -Y, about 1.17 tall).

All directions here are in ARMATURE space (Blender axes: x = her left, -y = front, z = up).
"""
import math
import os

import bpy
from mathutils import Matrix, Quaternion, Vector

B = "mixamorig:"


def load_rig(path, names=("Armature", "Body", "HeadMesh")):
    """Append the objects from a .blend into the current scene. Returns them in the order asked."""
    with bpy.data.libraries.load(os.path.abspath(path), link=False) as (src, dst):
        dst.objects = [n for n in names if n in src.objects]
    out = []
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
        out.append(o)
    bpy.context.view_layer.update()
    return out


def _update():
    bpy.context.view_layer.update()


def pb(arm, name):
    return arm.pose.bones[B + name]


def head_of(arm, name):
    _update()
    return pb(arm, name).head.copy()


def tail_of(arm, name):
    _update()
    return pb(arm, name).tail.copy()


def aim(arm, name, direction, twist=0.0):
    """Turn the bone (about its head) so it points along `direction` (armature space), by the smallest
    rotation, then roll `twist` degrees about its own axis. Children follow."""
    _update()
    p = pb(arm, name)
    M = p.matrix.copy()
    cur = (M.to_3x3() @ Vector((0, 1, 0))).normalized()
    want = Vector(direction).normalized()
    q = cur.rotation_difference(want)
    if twist:
        q = Quaternion(want, math.radians(twist)) @ q
    R = q.to_matrix().to_4x4()
    loc = M.translation.copy()
    new = R @ M
    new.translation = loc
    p.matrix = new
    _update()


def turn(arm, name, axis, deg):
    """Rotate the bone about its head around an armature-space axis."""
    _update()
    p = pb(arm, name)
    M = p.matrix.copy()
    R = Matrix.Rotation(math.radians(deg), 4, Vector(axis).normalized())
    loc = M.translation.copy()
    new = R @ M
    new.translation = loc
    p.matrix = new
    _update()


def reach(arm, upper, lower, target, pole):
    """Two-bone IK: put the end of `lower` at `target`, the joint bending toward `pole` (armature space)."""
    _update()
    a = pb(arm, upper)
    S = a.head.copy()
    l1 = (a.tail - a.head).length
    l2 = (pb(arm, lower).tail - pb(arm, lower).head).length
    T = Vector(target)
    d = T - S
    dist = min(d.length, (l1 + l2) * 0.999)
    d.normalize()
    # elbow on the circle around S->T, toward the pole
    cos_a = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    cos_a = max(-1.0, min(1.0, cos_a))
    along = l1 * cos_a
    up = math.sqrt(max(0.0, l1 * l1 - along * along))
    pv = Vector(pole) - S
    pv = (pv - d * pv.dot(d)).normalized()
    elbow = S + d * along + pv * up
    aim(arm, upper, elbow - S)
    aim(arm, lower, (S + d * dist) - elbow)


def bake(obj, name):
    """A new plain mesh object with the current pose (and every other modifier) applied, in world space."""
    _update()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=False, depsgraph=dg)
    me.name = name
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = obj.matrix_world.copy()
    o.vertex_groups.clear()
    return o


def palm_normal(arm, side):
    """Outward normal of the palm ("Left" / "Right"), armature space."""
    _update()
    h = (pb(arm, f"{side}Hand").tail - pb(arm, f"{side}Hand").head).normalized()
    across = pb(arm, f"{side}HandIndex1").head - pb(arm, f"{side}HandPinky1").head
    n = h.cross(across).normalized()
    return n if side == "Left" else -n


def face_palm(arm, side, toward):
    """Twist the hand about its own axis so the palm faces `toward` (a direction, armature space)."""
    _update()
    p = pb(arm, f"{side}Hand")
    h = (p.tail - p.head).normalized()
    n = palm_normal(arm, side)
    t = Vector(toward)
    t = (t - h * t.dot(h)).normalized()
    ang = n.angle(t)
    if n.cross(t).dot(h) < 0:
        ang = -ang
    turn(arm, f"{side}Hand", h, math.degrees(ang))


def move_weight(obj, src_names, dst_name, frac_of_vertex):
    """For every vertex, move frac_of_vertex(co) (0..1) of the weight of the `src_names` groups to `dst_name`."""
    groups = {g.name: g for g in obj.vertex_groups}
    src = [groups[B + n] for n in src_names if B + n in groups]
    dst = groups[B + dst_name]
    sidx = {g.index for g in src}
    for v in obj.data.vertices:
        f = frac_of_vertex(v.co)
        if f <= 0.0:
            continue
        moved = 0.0
        for e in v.groups:
            if e.group in sidx and e.weight > 0.0:
                d = e.weight * f
                obj.vertex_groups[e.group].add([v.index], e.weight - d, "REPLACE")
                moved += d
        if moved > 0.0:
            dst.add([v.index], moved, "ADD")


def smooth_weights(obj, radius=0.02, iterations=4, mix=0.6):
    """Blur all vertex weights over space (not edges: the Tripo meshes are many loose shells), so hard
    seams between neighbouring shells do not tear open when posed. Rows are renormalised."""
    import numpy as np
    from mathutils.kdtree import KDTree
    vs = obj.data.vertices
    n, G = len(vs), len(obj.vertex_groups)
    W = np.zeros((n, G), dtype=np.float64)
    for v in vs:
        for e in v.groups:
            W[v.index, e.group] = e.weight
    kd = KDTree(n)
    for v in vs:
        kd.insert(v.co, v.index)
    kd.balance()
    nb = [[i for _, i, _ in kd.find_range(v.co, radius)] for v in vs]
    for _ in range(iterations):
        avg = np.array([W[ix].mean(axis=0) for ix in nb])
        W = (1 - mix) * W + mix * avg
    W[W < 0.005] = 0.0
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    for gi, g in enumerate(obj.vertex_groups):
        col = W[:, gi]
        nz = np.nonzero(col)[0]
        z = np.nonzero(col == 0)[0]
        g.remove([int(i) for i in z])
        for i in nz:
            g.add([int(i)], float(col[i]), "REPLACE")
