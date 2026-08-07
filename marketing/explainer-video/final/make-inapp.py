#!/usr/bin/env python3
"""Encodes the in-app tutorial copies to a hard size budget.

Two-pass, because the budget is the requirement here: CRF gives you a quality target and whatever
size falls out of it, which is the wrong way round when the number that matters is megabytes on a
phone. Two-pass hits the byte target within a few percent.

The bitrate is computed backwards from the budget rather than guessed - audio first, container
overhead allowed for, and the remainder goes to picture.

  python3 make-inapp.py                 # both orientations, 5.6 MB budget
  python3 make-inapp.py --budget 4.0    # tighter
"""
import argparse, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
OUT = os.path.join(HERE, "inapp")

# Speech-only narration, so mono at 64k is transparent and frees ~100 kbps for the picture.
AUDIO_KBPS = 64
OVERHEAD = 0.015          # mp4 container + faststart index

VARIANTS = [
    ("CVApplyr-Tutorial-720p.mp4",     "CVApplyr-Explainer-1080p.mp4",     "1280:720"),
    ("CVApplyr-Tutorial-Vertical.mp4", "CVApplyr-Explainer-Vertical.mp4",  "720:1280"),
]


def dur(p):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", p], capture_output=True, text=True).stdout.strip())


def encode(name, src, size, budget_mb):
    src_path, out_path = os.path.join(HERE, src), os.path.join(OUT, name)
    d = dur(src_path)
    total_kbps = (budget_mb * 1024 * 1024 * 8) / d / 1000 * (1 - OVERHEAD)
    v_kbps = int(total_kbps - AUDIO_KBPS)

    vf = f"scale={size}:flags=lanczos"
    common = [
        "-c:v", "libx264", "-b:v", f"{v_kbps}k",
        "-maxrate", f"{int(v_kbps*1.6)}k", "-bufsize", f"{int(v_kbps*3)}k",
        "-preset", "veryslow", "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-level", "4.0",
        # 2s keyframes so scrubbing lands quickly; psy-rd biased toward holding fine detail,
        # since the thing worth seeing is small UI text inside a phone inside the frame.
        "-g", "60", "-keyint_min", "30", "-sc_threshold", "40",
        "-x264-params", "aq-mode=3:aq-strength=1.1:psy-rd=1.0,0.15:ref=6:bframes=4",
        "-vf", vf,
    ]
    log = os.path.join(OUT, f".pass-{name}")
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", src_path] + common +
                   ["-pass", "1", "-passlogfile", log, "-an", "-f", "null", os.devnull], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", src_path] + common +
                   ["-pass", "2", "-passlogfile", log,
                    "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k", "-ac", "1", "-ar", "48000",
                    "-movflags", "+faststart", out_path], check=True)
    for ext in (".log", "-0.log", ".log.mbtree", "-0.log.mbtree"):
        if os.path.exists(log + ext):
            os.remove(log + ext)

    mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"  {name:34s} {size.replace(':','x'):9s} {mb:5.2f} MB   video {v_kbps} kbps + audio {AUDIO_KBPS}k mono")
    return mb


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=float, default=5.6, help="MB per file")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    print(f"budget {a.budget} MB each\n")
    for name, src, size in VARIANTS:
        encode(name, src, size, a.budget)
