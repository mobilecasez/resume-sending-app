#!/usr/bin/env python3
"""Assembles the film.

Each scene is rendered to its own intermediate MP4 first, then the segments are joined with short
crossfades in a single graph. Building segment-by-segment keeps any one ffmpeg filter graph small
enough to debug, and lets a single scene be re-rendered without touching the rest.

The one rule that shapes everything: a scene is exactly as long as its narration. Picture is fitted
to voice, never the other way round. Where the source footage is shorter than the line, the last
frame holds - and because the holds land on the app's own confirmation screens ("Attached", "Done -
review & submit"), the pause reads as a beat rather than a stall.

Retiming respects the source frame rate. The auto-fill recording is 60fps, so it can be slowed up
to 2x and still land exactly on the 30fps output grid with no interpolation and no judder. The
24fps recordings get no slow-motion at all, because 24 -> 30 with a fractional slow would stutter
on exactly the vertical scrolls these clips are full of.

  python3 build.py                 # landscape master
  python3 build.py --vertical      # 1080x1920 cut
  python3 build.py --only 09,11    # re-render just those scenes, then rejoin
  python3 build.py --music bed.m4a # duck a music bed under the narration
"""
import argparse, json, math, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
FPS = 30
XFADE = 0.30          # crossfade between scenes; eats into each line's tail silence, never speech


def run(args, **kw):
    r = subprocess.run(args, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        sys.stderr.write("\nFFMPEG FAILED\n" + " ".join(args[:14]) + " ...\n")
        sys.stderr.write(r.stderr[-3000:] + "\n")
        raise SystemExit(1)
    return r


def probe(path, stream="v", entries="r_frame_rate"):
    return subprocess.run([FFPROBE, "-v", "error", "-select_streams", stream,
                           "-show_entries", f"stream={entries}", "-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip()


def dur(path):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def src_fps(path):
    a, b = probe(path).split("/")
    return float(a) / float(b)


class Build:
    def __init__(self, vertical, only, music):
        self.V = vertical
        self.W, self.H = (1080, 1920) if vertical else (1920, 1080)
        self.cards = os.path.join(HERE, "cards-v" if vertical else "cards")
        self.work = os.path.join(HERE, "work", "v" if vertical else "h")
        self.only = only
        self.music = music
        os.makedirs(self.work, exist_ok=True)
        self.cfg = json.load(open(os.path.join(HERE, "scenes.json")))
        self.vo = json.load(open(os.path.join(HERE, "vo", "durations.json")))["durations"]

        # Phone geometry. The recordings are a 496x1080 slice of a 1920x1080 capture; everything
        # downstream is derived from the height we want it to occupy so the two orientations stay
        # in proportion.
        if vertical:
            self.ph_h = 1120
            self.ph_x, self.ph_y = None, 530          # centred horizontally, headline above
        else:
            self.ph_h = 940
            self.ph_x, self.ph_y = 1288, 70
        self.ph_w = int(round(496 / 1080 * self.ph_h / 2) * 2)
        if self.ph_x is None:
            self.ph_x = (self.W - self.ph_w) // 2

    # ── static layers ────────────────────────────────────────────────────────
    def make_stage(self):
        """ground + the phone's drop shadow, flattened once into a single still."""
        from PIL import Image, ImageDraw, ImageFilter
        stage = Image.open(os.path.join(self.cards, "ground.png")).convert("RGBA")
        r = int(self.ph_h * 0.052)
        # A shadow with two falloffs: a tight contact shadow that anchors the device to the ground,
        # and a wide soft one that gives it air. One blur radius alone always looks like a sticker.
        for spread, offset, alpha in ((26, 16, 120), (72, 46, 96)):
            lay = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
            d = ImageDraw.Draw(lay)
            d.rounded_rectangle([self.ph_x, self.ph_y + offset,
                                 self.ph_x + self.ph_w, self.ph_y + self.ph_h + offset],
                                radius=r, fill=(2, 5, 12, alpha))
            stage = Image.alpha_composite(stage, lay.filter(ImageFilter.GaussianBlur(spread)))
        stage.convert("RGB").save(os.path.join(self.work, "stage.png"))

        # Alpha mask giving the capture the phone's corner radius, at capture resolution so it
        # scales with the footage instead of being applied after.
        m = Image.new("L", (496, 1080), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, 495, 1079], radius=int(1080 * 0.052), fill=255)
        m.save(os.path.join(self.work, "mask.png"))

        # A hairline device edge, so the white UI does not bleed straight into the ground.
        bez = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        ImageDraw.Draw(bez).rounded_rectangle(
            [self.ph_x, self.ph_y, self.ph_x + self.ph_w, self.ph_y + self.ph_h],
            radius=r, outline=(150, 168, 205, 92), width=2)
        bez.save(os.path.join(self.work, "bezel.png"))

    # ── retiming ─────────────────────────────────────────────────────────────
    def retime(self, sc, V):
        """-> (setpts multiplier, seconds of source to take, seconds of frozen tail).

        Speed factors are QUANTISED so every source frame maps to a whole number of output frames.
        This is not fussiness - it is the difference between a clean image and a shimmering one.

        A 60fps source slowed exactly 2x becomes 30fps content on a 30fps grid: one source frame,
        one output frame, no duplication and no drops. Any other factor (1.62x, say) lands source
        frames between output frames, and ffmpeg resolves that by repeating some and dropping
        others on an uneven cadence - which reads as stutter on exactly the vertical scrolls these
        recordings are full of.

        Where the quantised speed would overrun the line, the source segment is trimmed rather than
        the speed fudged. Losing a moment of footage costs less than losing image stability.
        """
        L = sc["out"] - sc["in"]
        slow = 2.0 if src_fps(self.cfg["sources"][sc["source"]]) >= 50 else 1.0
        if L * slow <= V:
            return slow, L, V - L * slow          # all of it, then hold the confirmation frame
        return slow, V / slow, 0.0                # trim the segment so it lands exactly on the line

    # ── scenes ───────────────────────────────────────────────────────────────
    def scene_screen(self, sc, V, out):
        path = self.cfg["sources"][sc["source"]]
        speed, take, hold = self.retime(sc, V)
        crop = self.cfg["phone_crop"]
        fade = min(0.55, V * 0.28)

        # The footage is scaled ONCE, straight to its final size, and never touched again. Every
        # extra resample of 400px-wide UI text is a chance for it to crawl.
        vf = (
            f"[1:v]crop={crop},setpts=PTS*{speed:.6f}/1,fps={FPS},"
            f"tpad=stop_mode=clone:stop_duration={hold:.3f},"
            f"scale={self.ph_w}:{self.ph_h}:flags=lanczos,setsar=1[ph];"
            f"[3:v]scale={self.ph_w}:{self.ph_h}:flags=lanczos,format=gray[mk];"
            f"[ph][mk]alphamerge[phm];"
            f"[0:v][phm]overlay={self.ph_x}:{self.ph_y}:format=auto[s1];"
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
             "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(FPS), out])

    def scene_anim(self, sc, V, out):
        """A built scene: every frame drawn from scratch in Chromium, then assembled.

        Nothing here is a still being pushed around, which is the whole point - the earlier cut got
        its movement from a zoompan over a rendered card, and re-scaling the same pixels slightly
        differently on each frame is what made the picture shimmer. A frame sequence can pull the
        camera back 2.4x and stay perfectly crisp, because there are no previous pixels to resample.
        """
        d = os.path.join(self.work, f"anim-{sc['id']}")
        cmd = ["node", os.path.join(HERE, "render-anim.js"), sc["id"], f"{V:.3f}"]
        if self.V:
            cmd.append("--vertical")
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE)
        if r.returncode != 0:
            sys.stderr.write(r.stdout + r.stderr); raise SystemExit(1)
        run([FFMPEG, "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(d, "%05d.png"),
             "-vf", f"format=yuv420p,fade=t=in:st=0:d=0.35,setsar=1", "-t", f"{V:.3f}",
             "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-r", str(FPS), out])

    # ── assembly ─────────────────────────────────────────────────────────────
    def join(self, segs, durs, out):
        n = len(segs)
        ins = []
        for s in segs:
            ins += ["-i", s]
        # Video: chained crossfades. Each xfade's offset is measured on the growing timeline, so it
        # accumulates the overlap already spent.
        parts, cur, off = [], "0:v", 0.0
        for i in range(1, n):
            off += durs[i - 1] - XFADE
            lbl = f"x{i}"
            parts.append(f"[{cur}][{i}:v]xfade=transition=fade:duration={XFADE}:offset={off:.3f}[{lbl}]")
            cur = lbl
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

        amaps = []
        for sid in self.ids:
            amaps += ["-i", os.path.join(HERE, "vo", f"{sid}.wav")]

        if self.music:
            ins_music = ["-stream_loop", "-1", "-i", self.music]
            parts.append(f"[{2 * n}:a]volume=0.12,afade=t=in:st=0:d=2,"
                         f"afade=t=out:st={total - 3:.2f}:d=3[bed]")
            # Sidechain the bed against the narration so words always sit on top of the music.
            parts.append("[bed][vox]sidechaincompress=threshold=0.04:ratio=8:attack=8:release=320[bedc]")
            parts.append("[vox][bedc]amix=inputs=2:normalize=0[amix]")
            alast = "amix"
        else:
            ins_music, alast = [], "vox"
        parts.append(f"[{alast}]loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=out:st={total-0.9:.3f}:d=0.9,atrim=0:{total:.3f},asetpts=N/SR/TB[ao]")

        # Top and tail: up from black into the presenter, down to black off the end card.
        parts.append(f"[{cur}]fade=t=out:st={total - 0.9:.3f}:d=0.9[vfin]")
        run([FFMPEG, "-v", "error", "-y"] + ins + amaps + ins_music +
            ["-filter_complex", ";".join(parts), "-map", "[vfin]", "-map", "[ao]",
             "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
             "-profile:v", "high", "-level", "4.1", "-movflags", "+faststart",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", f"{total:.3f}", out])
        return total

    def go(self):
        self.make_stage()
        segs, durs, self.ids = [], [], []
        for sc in self.cfg["scenes"]:
            V = self.vo[sc["id"]]
            seg = os.path.join(self.work, f"seg-{sc['id']}.mp4")
            need = (not self.only) or sc["id"] in self.only
            if need or not os.path.exists(seg):
                print(f"  scene {sc['id']} {sc['kind']:9s} {V:5.2f}s", flush=True)
                {"screen": self.scene_screen, "anim": self.scene_anim}[sc["kind"]](sc, V, seg)
            segs.append(seg); durs.append(dur(seg)); self.ids.append(sc["id"])

        name = "CVApplyr-Explainer-Vertical.mp4" if self.V else "CVApplyr-Explainer-1080p.mp4"
        out = os.path.join(HERE, name)
        print("  joining...", flush=True)
        total = self.join(segs, durs, out)
        print(f"\n{name}  {total:.1f}s  {os.path.getsize(out)/1e6:.1f} MB  {self.W}x{self.H}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--vertical", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--music", default="")
    a = ap.parse_args()
    Build(a.vertical, {x.strip() for x in a.only.split(",") if x.strip()}, a.music).go()
