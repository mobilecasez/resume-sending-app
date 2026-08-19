#!/usr/bin/env python3
"""Assembles the five films.

One rule shapes everything: a scene is exactly as long as its narration. Picture is fitted to
voice, never the other way round. Where the source footage runs out before the line does, the last
frame holds - and because the in/out points were chosen so segments end on the app's own
confirmation screens ("Saved", "Attached", "Done - review & submit"), a hold reads as a beat rather
than a stall.

Retiming respects the source frame rate, and the speed factor is QUANTISED to 1.0 or 2.0. That is
not fussiness, it is the difference between a clean image and a shimmering one: a 60fps source
slowed exactly 2x becomes 30fps content on a 30fps grid, one source frame to one output frame, no
duplication and no drops. Any other factor lands source frames between output frames and ffmpeg
resolves it by repeating some and dropping others on an uneven cadence - which reads as stutter on
exactly the vertical scrolls these recordings are full of. Where a quantised speed would overrun
the line, the SEGMENT is trimmed rather than the speed fudged.

Everything is 1080x1920. The source recordings are a 496x1080 slice of a 1920x1080 capture, so the
phone is scaled ONCE, straight to final size, and never resampled again.

  python3 build.py                    # all five
  python3 build.py --film 3           # just film 3
  python3 build.py --only f5-06       # re-render one scene, then rejoin its film
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
FPS = 30
W, H = 1080, 1920
STALL_WARN = 4.0      # a hold longer than this reads as a stall, not a beat
XFADE = 0.30          # crossfade between scenes; eats into each line's tail pad, never speech

# Mirrored exactly in render-cards.js. If one moves, both move.
PH_H = 1100
PH_W = round((496 / 1080) * PH_H / 2) * 2
PH_X = round((W - PH_W) / 2)
PH_Y = 560


def run(args, **kw):
    r = subprocess.run(args, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write("\nFFMPEG FAILED\n" + " ".join(args[:16]) + " ...\n")
        sys.stderr.write(r.stderr[-3000:] + "\n")
        raise SystemExit(1)
    return r


def probe(path, entries="r_frame_rate"):
    return subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v",
                           "-show_entries", f"stream={entries}", "-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip()


def dur(path):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def src_fps(path):
    a, b = probe(path).split("/")
    return float(a) / float(b)


class Build:
    def __init__(self, films, only):
        self.want_films = films
        self.only = only
        self.work = os.path.join(HERE, "work")
        self.cards = os.path.join(HERE, "cards")
        os.makedirs(self.work, exist_ok=True)
        self.cfg = json.load(open(os.path.join(HERE, "series.json")))
        vo = os.path.join(HERE, "vo", "durations.json")
        if not os.path.exists(vo):
            sys.exit("No vo/durations.json - run gen-vo.py first.")
        self.vo = json.load(open(vo))["durations"]

    # ── static layers ────────────────────────────────────────────────────────
    def make_stage(self):
        """ground + the phone's drop shadow, flattened once into a single still."""
        from PIL import Image, ImageDraw, ImageFilter
        stage = Image.open(os.path.join(self.cards, "ground.png")).convert("RGBA")
        r = int(PH_H * 0.052)
        # Two falloffs: a tight contact shadow that anchors the device to the ground, and a wide
        # soft one that gives it air. One blur radius alone always looks like a sticker.
        for spread, offset, alpha in ((26, 16, 120), (72, 46, 96)):
            lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            ImageDraw.Draw(lay).rounded_rectangle(
                [PH_X, PH_Y + offset, PH_X + PH_W, PH_Y + PH_H + offset], radius=r,
                fill=(2, 5, 12, alpha))
            stage = Image.alpha_composite(stage, lay.filter(ImageFilter.GaussianBlur(spread)))
        stage.convert("RGB").save(os.path.join(self.work, "stage.png"))

        # Alpha mask giving the capture the phone's corner radius, built at CAPTURE resolution so
        # it scales with the footage instead of being applied after.
        m = Image.new("L", (496, 1080), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, 495, 1079], radius=int(1080 * 0.052), fill=255)
        m.save(os.path.join(self.work, "mask.png"))

        # A hairline device edge, so the white UI does not bleed straight into the ground.
        bez = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(bez).rounded_rectangle(
            [PH_X, PH_Y, PH_X + PH_W, PH_Y + PH_H], radius=r, outline=(150, 168, 205, 92), width=2)
        bez.save(os.path.join(self.work, "bezel.png"))

    # ── retiming ─────────────────────────────────────────────────────────────
    def retime(self, sc, V):
        """-> (setpts multiplier, seconds of source to take, seconds of frozen tail)."""
        L = sc["out"] - sc["in"]
        slow = 2.0 if src_fps(self.cfg["sources"][sc["source"]]) >= 50 else 1.0
        if L * slow <= V:
            return slow, L, V - L * slow          # all of it, then hold the confirmation frame
        return slow, V / slow, 0.0                # trim the segment to land exactly on the line

    # ── scenes ───────────────────────────────────────────────────────────────
    def scene_screen(self, sc, V, out):
        path = self.cfg["sources"][sc["source"]]
        speed, take, hold = self.retime(sc, V)
        crop = self.cfg["phone_crop"]
        fade = min(0.55, V * 0.28)

        vf = (
            f"[1:v]crop={crop},setpts=PTS*{speed:.6f}/1,fps={FPS},"
            f"tpad=stop_mode=clone:stop_duration={hold:.3f},"
            f"scale={PH_W}:{PH_H}:flags=lanczos,setsar=1[ph];"
            f"[3:v]scale={PH_W}:{PH_H}:flags=lanczos,format=gray[mk];"
            f"[ph][mk]alphamerge[phm];"
            f"[0:v][phm]overlay={PH_X}:{PH_Y}:format=auto[s1];"
            f"[s1][4:v]overlay=0:0[s2];"
            # The caption arrives just after the picture, fading up as it rises the last 22px.
            f"[2:v]format=rgba,fade=t=in:st=0:d={fade:.2f}:alpha=1[pl];"
            f"[s2][pl]overlay=0:'if(lt(t,{fade:.2f}), 22*(1-t/{fade:.2f}), 0)':format=auto[vo]"
        )
        run([FFMPEG, "-v", "error", "-y",
             "-loop", "1", "-framerate", str(FPS), "-t", f"{V:.3f}", "-i", os.path.join(self.work, "stage.png"),
             "-ss", f"{sc['in']:.3f}", "-t", f"{take:.3f}", "-i", path,
             "-loop", "1", "-framerate", str(FPS), "-t", f"{V:.3f}", "-i", os.path.join(self.cards, f"plate-{sc['id']}.png"),
             "-loop", "1", "-framerate", str(FPS), "-t", f"{V:.3f}", "-i", os.path.join(self.work, "mask.png"),
             "-loop", "1", "-framerate", str(FPS), "-t", f"{V:.3f}", "-i", os.path.join(self.work, "bezel.png"),
             "-filter_complex", vf, "-map", "[vo]", "-t", f"{V:.3f}",
             "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p",
             "-r", str(FPS), out])

    def scene_anim(self, sc, V, out):
        """A built scene: every frame drawn from scratch in Chromium, then assembled."""
        d = os.path.join(self.work, f"anim-{sc['id']}")
        r = subprocess.run(["node", os.path.join(HERE, "render-anim.js"), sc["id"], f"{V:.3f}"],
                           capture_output=True, text=True, cwd=HERE)
        if r.returncode != 0:
            sys.stderr.write(r.stdout + r.stderr); raise SystemExit(1)
        run([FFMPEG, "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(d, "%05d.png"),
             "-vf", "format=yuv420p,fade=t=in:st=0:d=0.35,setsar=1", "-t", f"{V:.3f}",
             "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-r", str(FPS), out])

    # ── assembly ─────────────────────────────────────────────────────────────
    def join(self, ids, segs, durs, out):
        n = len(segs)
        ins = []
        for s in segs:
            ins += ["-i", s]
        # Video: chained crossfades. Each xfade offset is measured on the GROWING timeline, so it
        # accumulates the overlap already spent.
        parts, cur, off = [], "0:v", 0.0
        for i in range(1, n):
            off += durs[i - 1] - XFADE
            parts.append(f"[{cur}][{i}:v]xfade=transition=fade:duration={XFADE}:offset={off:.3f}[x{i}]")
            cur = f"x{i}"
        total = sum(durs) - (n - 1) * XFADE

        # Audio: every line placed at its own start on the timeline, then summed. The crossfade
        # overlap only ever falls inside the silent pad each line already carries.
        astarts, t = [], 0.0
        for i in range(n):
            astarts.append(t)
            t += durs[i] - XFADE
        for i in range(n):
            parts.append(f"[{n + i}:a]adelay={int(astarts[i] * 1000)}|{int(astarts[i] * 1000)}[a{i}]")
        parts.append("".join(f"[a{i}]" for i in range(n)) +
                     f"amix=inputs={n}:normalize=0:dropout_transition=0[vox]")
        parts.append(f"[vox]loudnorm=I=-16:TP=-1.5:LRA=11,"
                     f"afade=t=out:st={total - 0.9:.3f}:d=0.9,atrim=0:{total:.3f},"
                     f"asetpts=N/SR/TB[ao]")
        parts.append(f"[{cur}]fade=t=out:st={total - 0.9:.3f}:d=0.9[vfin]")

        amaps = []
        for sid in ids:
            amaps += ["-i", os.path.join(HERE, "vo", f"{sid}.wav")]

        run([FFMPEG, "-v", "error", "-y"] + ins + amaps +
            ["-filter_complex", ";".join(parts), "-map", "[vfin]", "-map", "[ao]",
             "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
             "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", f"{total:.3f}", out])
        return total

    def go(self):
        self.make_stage()
        made = []
        for film in self.cfg["films"]:
            if self.want_films and film["n"] not in self.want_films:
                continue
            print(f"\nFilm {film['n']} - {film['title']}", flush=True)
            segs, durs, ids, stalls = [], [], [], []
            for sc in film["scenes"]:
                V = self.vo.get(sc["id"])
                if V is None:
                    sys.exit(f"no narration measured for {sc['id']} - run gen-vo.py")
                # The failure mode this catches: a line so much longer than its footage that the
                # picture freezes for most of the scene. It is invisible in the config - only the
                # ratio of narration to footage shows it - so it is reported on every build.
                if sc["kind"] == "screen":
                    _, take, hold = self.retime(sc, V)
                    if hold > STALL_WARN:
                        stalls.append((sc["id"], hold, V))
                seg = os.path.join(self.work, f"seg-{sc['id']}.mp4")
                # --only names the scenes to redo; otherwise redo what is missing, or everything
                # under --rebuild. A missing segment is always rebuilt whatever the flags say.
                need = (sc["id"] in self.only) if self.only else (self.rebuild_all)
                if need or not os.path.exists(seg):
                    print(f"  {sc['id']} {sc['kind']:6s} {V:5.2f}s", flush=True)
                    {"screen": self.scene_screen, "anim": self.scene_anim}[sc["kind"]](sc, V, seg)
                segs.append(seg); durs.append(dur(seg)); ids.append(sc["id"])

            if stalls:
                print(f"  ⚠️  {len(stalls)} scene(s) hold a frozen frame over {STALL_WARN:.1f}s:",
                      flush=True)
                for sid, hold, V in stalls:
                    print(f"       {sid}  {hold:.1f}s frozen of {V:.1f}s "
                          f"- shorten the line or widen its in/out", flush=True)

            out = os.path.join(HERE, f"{film['slug']}.mp4")
            print("  joining...", flush=True)
            total = self.join(ids, segs, durs, out)
            mb = os.path.getsize(out) / 1e6
            print(f"  -> {os.path.basename(out)}  {total:.1f}s  {mb:.1f} MB")
            made.append((film, total, mb))

        print(f"\n{'film':<5}{'length':>9}{'size':>9}   file")
        for film, t, mb in made:
            print(f"{film['n']:<5}{t:>8.1f}s{mb:>8.1f}M   {film['slug']}.mp4")
        print(f"\ntotal {sum(t for _, t, _ in made):.1f}s across {len(made)} films, {W}x{H}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--film", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("--rebuild", action="store_true", help="re-render every scene, not just missing")
    a = ap.parse_args()
    b = Build({int(x) for x in a.film.split(",") if x.strip()},
              {x.strip() for x in a.only.split(",") if x.strip()})
    b.rebuild_all = a.rebuild
    b.go()
