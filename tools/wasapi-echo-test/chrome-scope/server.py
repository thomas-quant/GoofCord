#!/usr/bin/env python3
"""Serves the capture-scope probe, launches the out-of-tree tone players, receives the WAV.

The players go through WMI Win32_Process.Create so they are parented to WmiPrvSE, not to us --
same discipline as device-scope-test.mjs. Here it matters less (Chrome is the capturer, not us)
but it keeps the two harnesses comparable.
"""
import http.server, subprocess, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WIN_HERE = r"E:\backup\code\personal\GoofCord\tools\wasapi-echo-test"
VLC = r"C:\Program Files\VideoLAN\VLC\vlc.exe"
SPEAKERS = "{0.0.0.00000000}.{5a31bb14-b764-4610-bd44-e44fdae8b935}"
VAC = "{0.0.0.00000000}.{7036a79c-9355-46d6-bbb8-c4ce358323c9}"
pids = []


def spawn(dev, wav):
    cmd = f'"{VLC}" --intf dummy --no-video --play-and-exit --aout=mmdevice --mmdevice-audio-device="{dev}" "{WIN_HERE}\\{wav}"'
    ps = f"$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{cmd}'}}; Write-Output $r.ProcessId"
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command", ps], capture_output=True, text=True)
    pid = out.stdout.strip().split()[-1] if out.stdout.strip() else "?"
    print(f"  spawned {wav} -> {dev[-14:]}  pid={pid}", flush=True)
    return pid


def kill_all():
    """Any error path in the page must not leave tones playing in someone's ears."""
    subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                    "Get-Process vlc -ErrorAction SilentlyContinue | Stop-Process -Force"],
                   capture_output=True)


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def log_message(self, *a):
        pass

    def do_POST(self):
        global pids
        if self.path == "/stop":
            kill_all()
            self.send_response(204); self.end_headers(); return
        if self.path == "/start":
            kill_all()  # never stack players across runs
            print("[server] page asked for tones", flush=True)
            pids = [spawn(VAC, "tone-997.wav"), spawn(SPEAKERS, "tone-440.wav")]
            self.send_response(204); self.end_headers(); return
        if self.path.startswith("/upload"):
            n = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(n)
            import urllib.parse as _u
            q = _u.parse_qs(_u.urlparse(self.path).query).get("restrict", [None])[0]
            out = os.path.join(HERE, f"chrome-capture-{q}.wav" if q else "chrome-capture.wav")
            with open(out, "wb") as f:
                f.write(data)
            print(f"[server] received {n} bytes -> {out}", flush=True)
            kill_all()
            self.send_response(204); self.end_headers()
            print("[server] DONE", flush=True)
            return
        self.send_response(404); self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    kill_all()
    print(f"serving {HERE} on http://localhost:{port}", flush=True)
    http.server.HTTPServer(("0.0.0.0", port), H).serve_forever()
