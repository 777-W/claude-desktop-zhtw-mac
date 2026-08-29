"""Minimal asar reader/writer (Electron archive format)."""
import json, struct, os

def read(path):
    d = open(path, "rb").read()
    json_len = struct.unpack("<I", d[12:16])[0]
    header = json.loads(d[16:16 + json_len].decode("utf-8"))
    base = 16 + json_len
    base += (4 - base % 4) % 4          # 4-byte align
    return d, header, base

def _walk(node, files, prefix=""):
    for name, meta in node.get("files", {}).items():
        p = prefix + "/" + name if prefix else name
        if "files" in meta:
            _walk(meta, files, p)
        else:
            files.append((p, meta))

def extract_all(path):
    d, header, base = read(path)
    files = []
    _walk(header, files)
    out = {}
    for p, meta in files:
        if "offset" in meta:
            o = int(meta["offset"]); s = int(meta["size"])
            out[p] = d[base + o: base + o + s]
        else:
            out[p] = None                # symlink / unpacked
    return header, out

def write(path, header, contents):
    """Rebuild an asar. `contents` maps path -> bytes (None keeps meta as-is)."""
    blobs, offset = [], 0
    def rebuild(node, prefix=""):
        nonlocal offset
        newnode = {"files": {}}
        for name, meta in node.get("files", {}).items():
            p = prefix + "/" + name if prefix else name
            if "files" in meta:
                newnode["files"][name] = rebuild(meta, p)
            else:
                m = dict(meta)
                data = contents.get(p)
                if data is not None and "offset" in meta:
                    m["offset"] = str(offset)
                    m["size"] = len(data)
                    blobs.append(data)
                    offset += len(data)
                newnode["files"][name] = m
        return newnode
    new_header = rebuild(header)
    js = json.dumps(new_header, separators=(",", ":")).encode("utf-8")
    pad = (4 - len(js) % 4) % 4
    head = struct.pack("<I", 4) + struct.pack("<I", len(js) + pad + 8) \
         + struct.pack("<I", len(js) + pad + 4) + struct.pack("<I", len(js))
    with open(path, "wb") as f:
        f.write(head); f.write(js); f.write(b"\0" * pad)
        for b in blobs: f.write(b)
    return js            # header json bytes (for the integrity hash)
