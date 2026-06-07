#!/usr/bin/env python3
"""
smoke_test.py — CI guardrail for the single-file app (index.html).

After 30+ commits on a 13k-line monolith with no test suite, regressions slip in
silently. This catches the common ones BEFORE they ship, on every push:
  1. JS syntax errors (extract inline <script> → node --check)
  2. onclick/handlers pointing at undefined functions (would throw on click)
  3. duplicate function definitions (a classic monolith bug)

Exits non-zero on any real problem so the GitHub Actions job fails loudly.
"""

import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, "..", "index.html")

# JS/DOM builtins & globals that legitimately appear in inline handlers
BUILTINS = {
    "Date", "Math", "JSON", "Number", "String", "Array", "Object", "Boolean",
    "console", "document", "window", "event", "this", "navigator", "location",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "alert",
    "confirm", "prompt", "parseInt", "parseFloat", "encodeURIComponent",
    "decodeURIComponent", "isNaN", "Promise", "fetch", "localStorage", "RegExp",
    "if", "for", "while", "return", "typeof", "new", "void", "delete",
    # CSS functions that appear inside inline style strings within handlers
    "rgba", "rgb", "hsl", "hsla", "var", "calc", "scale", "scaleX", "scaleY",
    "translate", "translateX", "translateY", "translateZ", "rotate", "url",
    "linear-gradient", "radial-gradient", "blur", "brightness",
}


def fail(msg):
    print(f"❌ SMOKE TEST FAILED: {msg}")
    sys.exit(1)


def main():
    html = open(INDEX, encoding="utf-8").read()
    scripts = "\n".join(re.findall(r"<script>(.*?)</script>", html, re.DOTALL))
    print(f"  index.html: {round(len(html)/1024)} KB")

    # ── 1. JS syntax ──────────────────────────────────────────────────────
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False) as f:
        f.write(scripts)
        tmp = f.name
    r = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    os.unlink(tmp)
    if r.returncode != 0:
        fail("JS syntax error:\n" + (r.stderr or r.stdout)[:500])
    print("  ✓ JS syntax OK")

    # ── 2. defined functions / globals ────────────────────────────────────
    defined = set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", scripts))
    defined |= set(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()", scripts))
    defined |= set(re.findall(r"window\.([A-Za-z_$][\w$]*)\s*=", scripts))

    # ── 3. inline handlers → undefined function calls ─────────────────────
    handlers = re.findall(r'on(?:click|change|input|keydown|mouseover|mouseout|submit)\s*=\s*"([^"]+)"', html)
    handlers += re.findall(r"on(?:click|change|input|keydown|mouseover|mouseout|submit)\s*=\s*'([^']+)'", html)
    missing = set()
    for h in handlers:
        # bare calls only: X( not preceded by a dot (method) or word char
        for m in re.findall(r"(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(", h):
            if m not in defined and m not in BUILTINS:
                missing.add(m)
    if missing:
        fail("onclick handlers call undefined functions: " + ", ".join(sorted(missing)))
    print(f"  ✓ all inline handlers resolve ({len(handlers)} checked)")

    # ── 4. duplicate function definitions ─────────────────────────────────
    defs = re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)\s*\(", scripts)
    from collections import Counter
    dups = {k: v for k, v in Counter(defs).items() if v > 1}
    if dups:
        fail("duplicate function definitions: " + str(dups))
    print(f"  ✓ no duplicate functions ({len(set(defs))} unique)")

    print("✅ SMOKE TEST PASSED")


if __name__ == "__main__":
    main()
