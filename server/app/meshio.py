"""Экспорт мешей: GLB (для просмотра в приложении), PLY, STL, OBJ.

Без внешних зависимостей, только numpy. Все функции принимают:
  v - (N,3) float32 вершины
  f - (M,3) int треугольники
  c - (N,3) uint8 цвета вершин (RGB)
"""
import json
import struct

import numpy as np


def vertex_normals(v, f):
    v = v.astype(np.float64)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        for ax in range(3):
            n[:, ax] += np.bincount(f[:, k], weights=fn[:, ax], minlength=len(v))
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln[ln < 1e-12] = 1.0
    return (n / ln).astype(np.float32)


def write_glb(path, v, f, c):
    v = np.ascontiguousarray(v, dtype="<f4")
    f = np.ascontiguousarray(f, dtype="<u4")
    n = np.ascontiguousarray(vertex_normals(v, f), dtype="<f4")
    rgba = np.concatenate([c.astype(np.uint8), np.full((len(c), 1), 255, np.uint8)], axis=1)
    rgba = np.ascontiguousarray(rgba)

    idx_b = f.tobytes()
    pos_b = v.tobytes()
    nor_b = n.tobytes()
    col_b = rgba.tobytes()
    # все блоки кратны 4 байтам: u32 / f32 / rgba8
    blob = idx_b + pos_b + nor_b + col_b
    o_idx, o_pos = 0, len(idx_b)
    o_nor = o_pos + len(pos_b)
    o_col = o_nor + len(nor_b)

    gltf = {
        "asset": {"version": "2.0", "generator": "scan3d"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 1, "NORMAL": 2, "COLOR_0": 3},
            "indices": 0, "material": 0, "mode": 4}]}],
        "materials": [{
            "pbrMetallicRoughness": {
                "baseColorFactor": [1, 1, 1, 1],
                "metallicFactor": 0.0, "roughnessFactor": 0.85},
            "doubleSided": True}],
        "accessors": [
            {"bufferView": 0, "componentType": 5125, "count": int(f.size), "type": "SCALAR"},
            {"bufferView": 1, "componentType": 5126, "count": int(len(v)), "type": "VEC3",
             "min": [float(x) for x in v.min(axis=0)], "max": [float(x) for x in v.max(axis=0)]},
            {"bufferView": 2, "componentType": 5126, "count": int(len(v)), "type": "VEC3"},
            {"bufferView": 3, "componentType": 5121, "normalized": True,
             "count": int(len(v)), "type": "VEC4"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": o_idx, "byteLength": len(idx_b), "target": 34963},
            {"buffer": 0, "byteOffset": o_pos, "byteLength": len(pos_b), "target": 34962},
            {"buffer": 0, "byteOffset": o_nor, "byteLength": len(nor_b), "target": 34962},
            {"buffer": 0, "byteOffset": o_col, "byteLength": len(col_b), "target": 34962},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    blob += b"\x00" * ((4 - len(blob) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A))
        fh.write(js)
        fh.write(struct.pack("<II", len(blob), 0x004E4942))
        fh.write(blob)


def write_ply(path, v, f, c):
    vd = np.empty(len(v), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                 ("r", "u1"), ("g", "u1"), ("b", "u1")])
    vd["x"], vd["y"], vd["z"] = v[:, 0], v[:, 1], v[:, 2]
    vd["r"], vd["g"], vd["b"] = c[:, 0], c[:, 1], c[:, 2]
    fd = np.empty(len(f), dtype=[("n", "u1"), ("i", "<i4", (3,))])
    fd["n"] = 3
    fd["i"] = f
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        "comment scan3d\n"
        f"element vertex {len(v)}\n"
        "property float x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n"
        f"element face {len(f)}\n"
        "property list uchar int vertex_indices\n"
        "end_header\n")
    with open(path, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(vd.tobytes())
        fh.write(fd.tobytes())


def write_stl(path, v, f, c=None):
    v = v.astype(np.float32)
    tri = v[f]  # (M,3,3)
    nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    ln[ln < 1e-20] = 1.0
    nrm = (nrm / ln).astype(np.float32)
    rec = np.zeros(len(f), dtype=[("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("a", "<u2")])
    rec["n"] = nrm
    rec["v"] = tri
    with open(path, "wb") as fh:
        fh.write(b"scan3d binary STL".ljust(80, b" "))
        fh.write(struct.pack("<I", len(f)))
        fh.write(rec.tobytes())


def write_obj(path, v, f, c):
    """OBJ с цветами вершин (v x y z r g b) - читают Blender, MeshLab, Meshmixer."""
    cf = c.astype(np.float32) / 255.0
    with open(path, "w") as fh:
        fh.write("# scan3d\n")
        np.savetxt(fh, np.hstack([v.astype(np.float64), cf]), fmt="v %.6f %.6f %.6f %.4f %.4f %.4f")
        np.savetxt(fh, f.astype(np.int64) + 1, fmt="f %d %d %d")
