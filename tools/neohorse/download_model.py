#!/usr/bin/env python3
"""Download the author's NeoHorse ModelScope bundle and verify snapshot hashes."""

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import time
import urllib.parse
import urllib.request

MODEL = "TokenRhythm/NeoHorse-Jev-4B"
BASE = f"https://www.modelscope.cn/api/v1/models/{MODEL}"


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    evidence = root / "evidence"
    evidence.mkdir(parents=True, exist_ok=True)
    snapshot = evidence / "modelscope-files.json"
    if not snapshot.exists():
        url = BASE + "/repo/files?Revision=master&Recursive=true"
        with urllib.request.urlopen(url, timeout=30) as response:
            snapshot.write_bytes(response.read())
    metadata = json.loads(snapshot.read_text())
    if not metadata.get("Success"):
        raise RuntimeError("ModelScope did not return a successful file listing")
    files = [item for item in metadata["Data"]["Files"]
             if item["Type"] != "tree" and not item["Path"].startswith("assets/")]
    target = root / "model"
    target.mkdir(exist_ok=True)

    def download(item):
        relative = pathlib.PurePosixPath(item["Path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("Unsafe file path in upstream metadata")
        path = target.joinpath(*relative.parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        expected = item.get("Sha256", "")
        if len(expected) != 64:
            raise ValueError(f"Missing SHA-256 for {relative}")
        if path.is_file() and path.stat().st_size == item["Size"] and sha256(path) == expected:
            return {"path": str(relative), "sha256": expected, "size": item["Size"]}
        part = path.with_name(path.name + ".part")
        url = BASE + "/repo?" + urllib.parse.urlencode({"Revision": "master", "FilePath": str(relative)})
        for attempt in range(3):
            try:
                offset = part.stat().st_size if part.exists() else 0
                if offset > item["Size"]:
                    offset = 0
                if offset != item["Size"] or not part.exists():
                    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
                    with urllib.request.urlopen(request, timeout=60) as response:
                        append = offset > 0 and response.status == 206
                        if append and not response.headers.get("Content-Range", "").startswith(f"bytes {offset}-"):
                            raise ValueError("Server returned an unexpected byte range")
                        written = offset if append else 0
                        report_at = time.monotonic() + 20
                        with part.open("ab" if append else "wb") as stream:
                            while block := response.read(4 * 1024 * 1024):
                                stream.write(block)
                                written += len(block)
                                if time.monotonic() >= report_at:
                                    print(f"DOWNLOAD {relative}: {written}/{item['Size']} bytes", flush=True)
                                    report_at = time.monotonic() + 20
                if part.stat().st_size != item["Size"] or sha256(part) != expected:
                    part.unlink(missing_ok=True)
                    raise ValueError(f"Size or SHA-256 mismatch: {relative}")
                part.replace(path)
                print(f"VERIFIED {relative} ({item['Size']} bytes)", flush=True)
                return {"path": str(relative), "sha256": expected, "size": item["Size"]}
            except Exception as error:
                print(f"RETRY {relative} attempt={attempt + 1}: {error}", flush=True)
                if attempt == 2:
                    raise
                time.sleep(2 * (attempt + 1))

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        verified = list(executor.map(download, files))
    (evidence / "verified-model-files.json").write_text(json.dumps({
        "model": MODEL, "source": BASE,
        "snapshot_sha256": sha256(snapshot), "files": verified,
    }, indent=2) + "\n")
    print(f"DONE {len(verified)} verified files; {sum(item['size'] for item in verified)} bytes", flush=True)


if __name__ == "__main__":
    main()
