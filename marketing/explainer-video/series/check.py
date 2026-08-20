#!/usr/bin/env python3
"""Post-build checks. Run this before sending anything anywhere.

Three things get verified, all of them things that have actually gone wrong on this project:

1. SHIMMER. The complaint that forced the 90-second film to be re-cut was "the screen, images is
   flickering a lot". The cause was a zoompan push re-sampling the same still slightly differently
   on every frame. It is measurable: sample a window that should be visually still and take the
   mean absolute difference between consecutive frames. A genuinely static hold scores ~0. Anything
   above about 1.5 is the eye seeing crawl on fine UI text.

2. LAST FRAME. A film that ends on an iOS share sheet, a spinner, or a half-drawn transition looks
   like a mistake even when everything before it is right. The final frame of each film is written
   out so it can be looked at.

3. SHAPE. Dimensions, frame rate, duration, faststart, audio track present.

  python3 check.py                 # all five
  python3 check.py --film 2
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
SHIMMER_WARN = 1.5


def probe(path, args):
    return subprocess.run([FFPROBE, "-v", "error"] + args + ["-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip()


def shimmer(path, start, dur=1.6):
    """Mean absolute difference between consecutive frames over a window, 0-255."""
    r = subprocess.run(
        [FFMPEG, "-v", "error", "-ss", f"{start:.2f}", "-t", f"{dur:.2f}", "-i", path,
         "-vf", "format=gray,tblend=all_mode=difference,signalstats,"
                "metadata=print:key=lavfi.signalstats.YAVG",
         "-f", "null", "-"], capture_output=True, text=True)
    vals = [float(l.split("=")[1]) for l in r.stderr.splitlines()
            if "lavfi.signalstats.YAVG" in l]
    # Drop the first: the very first tblend output compares against an empty frame.
    vals = vals[1:]
    return (sum(vals) / len(vals), max(vals)) if vals else (0.0, 0.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--film", default="")
    a = ap.parse_args()
    want = {int(x) for x in a.film.split(",") if x.strip()}

    cfg = json.load(open(os.path.join(HERE, "series.json")))
    vo = json.load(open(os.path.join(HERE, "vo", "durations.json")))["durations"]
    shots = os.path.join(HERE, "work", "lastframes")
    os.makedirs(shots, exist_ok=True)

    bad = 0
    for film in cfg["films"]:
        if want and film["n"] not in want:
            continue
        path = os.path.join(HERE, f"{film['slug']}.mp4")
        if not os.path.exists(path):
            print(f"film {film['n']}  MISSING {film['slug']}.mp4"); bad += 1; continue

        w, h = probe(path, ["-select_streams", "v:0", "-show_entries", "stream=width,height"]).split(",")
        fps = probe(path, ["-select_streams", "v:0", "-show_entries", "stream=r_frame_rate"])
        d = float(probe(path, ["-show_entries", "format=duration"]))
        acodec = probe(path, ["-select_streams", "a:0", "-show_entries", "stream=codec_name"])
        mb = os.path.getsize(path) / 1e6

        print(f"\nfilm {film['n']}  {film['slug']}.mp4")
        ok_shape = (w == "1080" and h == "1920" and fps == "30/1" and acodec == "aac")
        print(f"  {w}x{h}  {fps}fps  {d:.1f}s  {mb:.1f} MB  audio={acodec or 'NONE'}"
              f"   {'ok' if ok_shape else '<<< WRONG'}")
        if not ok_shape:
            bad += 1

        # THE STALE-FILM CHECK. A film's length is fully determined by its narration (scene =
        # line, minus one crossfade per cut), so a file that does not match the current
        # durations.json was joined against OLD audio. Exactly this shipped once: the build
        # crashed on film 4, the failure was piped through `tail` and lost, and two films went
        # out carrying the scratch voice while every shape check passed.
        expect = sum(vo[s["id"]] for s in film["scenes"]) - (len(film["scenes"]) - 1) * 0.30
        drift = abs(d - expect)
        print(f"  duration vs narration: {d:.1f}s vs {expect:.1f}s expected"
              f"{'' if drift <= 0.5 else '   <<< STALE - built from older narration'}")
        if drift > 0.5:
            bad += 1

        # Sample the tail of each screen scene - that is where a frame is held, and where any
        # crawl on the UI text would show up worst.
        t = 0.0
        worst, n_sampled = None, 0
        for sc in film["scenes"]:
            V = vo[sc["id"]]
            if sc["kind"] == "screen" and V > 2.4:
                # 0.9s before the scene ends: inside the hold, clear of the crossfade.
                at = t + V - 1.5
                if at + 1.6 < d:
                    avg, mx = shimmer(path, at)
                    n_sampled += 1
                    if worst is None or avg > worst[0]:
                        worst = (avg, mx, sc["id"])
            t += V - 0.30

        if worst is None:
            print("  shimmer: no scene long enough to sample")
        else:
            flag = "" if worst[0] <= SHIMMER_WARN else "   <<< CRAWL"
            print(f"  shimmer {worst[0]:.2f} avg / {worst[1]:.2f} max on the worst of "
                  f"{n_sampled} holds ({worst[2]}){flag}")
            if worst[0] > SHIMMER_WARN:
                bad += 1

        # Sampled BEFORE the 0.9s fade-out, not at the very last frame - the last frame is
        # black by design, and black tells you nothing about whether the film ends well.
        last = os.path.join(shots, f"{film['slug']}-last.png")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-sseof", "-1.2", "-i", path,
                        "-update", "1", "-frames:v", "1", last], check=True)
        print(f"  last frame -> work/lastframes/{os.path.basename(last)}")

    print(f"\n{'all checks passed' if not bad else str(bad) + ' problem(s)'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
