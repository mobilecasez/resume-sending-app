#!/usr/bin/env python3
"""Narration for the five-part series - one WAV per scene, via Gemini TTS.

Same approach as the 90-second film, and deliberately the SAME voice and the same delivery
direction: five films released together should sound like one person recorded them in one sitting,
not like five separate jobs. The direction below is what enforces that across ~50 separate API
calls.

The measured duration of each line is what times its scene (see build.py). Nothing here knows or
cares how long a scene is meant to be.

  python3 gen-vo.py                 # every line in every film
  python3 gen-vo.py --film 2        # just film 2
  python3 gen-vo.py --only f2-05    # re-record one line
  python3 gen-vo.py --force         # re-record lines that already exist
  python3 gen-vo.py --scratch       # local macOS voice, NOT for release - see below

SCRATCH MODE exists because the narration and the picture are coupled: a scene is exactly as long
as its line, so nothing downstream can be built or judged until some audio exists. When the Gemini
key has no credit, --scratch lays down a local `say` track at 141 words per minute - the measured
speaking rate of the released 90-second film - so the cut, the plates and the animation can all be
built and reviewed at close to final timings. Re-run without --scratch once a funded key is in
place and every film re-times itself around the real voice.
"""
import argparse, base64, json, os, struct, subprocess, sys, urllib.request, time

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
MODEL = "gemini-3.1-flash-tts-preview"

# One direction, prepended to every line. Naming the product's pronunciation matters: left alone,
# "CVApplyr" comes back as a single mangled word instead of the letters plus "applier". These are
# how-to films rather than an advert, so the direction asks for a slower, more explanatory read
# than the 90-second cut got.
DIRECTION = (
    "You are narrating a short how-to video for a phone app. Read the line below calmly and "
    "clearly, like you are sitting next to someone showing them how something works - patient, "
    "unhurried, warm mid-pitch, neutral international English. No advertising lilt, no rising "
    "excitement at the end of sentences. Pronounce 'CVApplyr' as 'C V Applier'. Pronounce "
    "'ATS' as the letters A T S. Read only the line, nothing else.\n\nLine: "
)


def api_key():
    for p in (os.path.join(HERE, ".gemini-key"), os.path.expanduser("~/.gemini-key")):
        if os.path.exists(p):
            k = open(p).read().strip()
            if k:
                return k
    k = os.environ.get("GEMINI_API_KEY", "").strip()
    if k:
        return k
    sys.exit("No Gemini key. Put it in series/.gemini-key or export GEMINI_API_KEY.")


def tts(text, voice, key, tries=5):
    """One line -> raw PCM bytes. Retries on the 429/503 the preview models throw under load."""
    body = json.dumps({
        "contents": [{"parts": [{"text": DIRECTION + text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}},
        },
    }).encode()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}"
    last = ""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=240) as r:
                d = json.loads(r.read())
            return base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
        except Exception as e:
            last = str(e)[:200]
            if attempt < tries - 1:
                time.sleep(2 ** attempt * 3)
    raise RuntimeError(f"TTS failed after {tries} tries: {last}")


def write_wav(path, pcm, rate=24000):
    n = len(pcm)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data" + struct.pack("<I", n) + pcm)


# 141 wpm is not a guess: it is the measured rate of the released 90-second film's narration
# (193 words over 81.9s of speech). Matching it keeps scratch timings within a few percent of what
# the real voice will produce, so the edit reviewed now is the edit that ships.
SCRATCH_WPM = 141


def scratch(text, out_wav):
    """A local stand-in track. Robotic on purpose - nobody should mistake it for the release."""
    aiff = out_wav.replace(".wav", ".aiff")
    # No --data-format: this build of `say` rejects it for AIFF ("Opening output file failed").
    # ffmpeg resamples on the next line anyway, so the container default is fine.
    subprocess.run(["say", "-v", "Daniel", "-r", str(SCRATCH_WPM), "-o", aiff, text], check=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", aiff, "-ar", "24000", "-ac", "1", out_wav],
                   check=True)
    os.remove(aiff)


def dur(path):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice")
    ap.add_argument("--out", default="vo")
    ap.add_argument("--only", default="")
    ap.add_argument("--film", default="")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--scratch", action="store_true")
    a = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, "series.json")))
    voice = a.voice or cfg.get("voice", "Charon")
    outdir = os.path.join(HERE, a.out)
    os.makedirs(outdir, exist_ok=True)
    key = None if a.scratch else api_key()
    only = {s.strip() for s in a.only.split(",") if s.strip()}
    films = {int(x) for x in a.film.split(",") if x.strip()}

    manifest, total, made = {}, 0.0, 0
    for film in cfg["films"]:
        if films and film["n"] not in films:
            # Still measure what is already on disk, so durations.json stays complete.
            for sc in film["scenes"]:
                f = os.path.join(outdir, f"{sc['id']}.wav")
                if os.path.exists(f):
                    d = dur(f); manifest[sc["id"]] = d; total += d
            continue

        print(f"\nFilm {film['n']} - {film['title']}", flush=True)
        for sc in film["scenes"]:
            sid = sc["id"]
            raw = os.path.join(outdir, f"{sid}.raw.wav")
            final = os.path.join(outdir, f"{sid}.wav")
            if only and sid not in only:
                if os.path.exists(final):
                    d = dur(final); manifest[sid] = d; total += d
                continue
            if os.path.exists(final) and not only and not a.force:
                d = dur(final); manifest[sid] = d; total += d
                print(f"  [{sid}] kept   {d:5.2f}s", flush=True)
                continue

            print(f"  [{sid}] {'say(scratch)' if a.scratch else voice}: {sc['vo'][:52]}...", flush=True)
            if a.scratch:
                scratch(sc["vo"], raw)
            else:
                write_wav(raw, tts(sc["vo"], voice, key))
            # Trim the silence the model pads on, level every line to one loudness target, then
            # give each line a fixed 0.15s head and 0.45s tail so scenes never collide at a splice.
            subprocess.run([
                FFMPEG, "-v", "error", "-y", "-i", raw, "-af",
                "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:"
                "detection=peak,areverse,"
                "silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:"
                "detection=peak,areverse,"
                "loudnorm=I=-16:TP=-1.5:LRA=11,"
                "adelay=150|150,apad=pad_dur=0.45",
                "-ar", "48000", "-ac", "2", final,
            ], check=True)
            os.remove(raw)
            d = dur(final); manifest[sid] = d; total += d; made += 1
            print(f"         -> {d:5.2f}s", flush=True)

    json.dump({"voice": voice, "durations": manifest},
              open(os.path.join(outdir, "durations.json"), "w"), indent=2)

    print(f"\n{made} new line(s). {len(manifest)} total, {total:.1f}s of narration.")
    for film in cfg["films"]:
        t = sum(manifest.get(s["id"], 0) for s in film["scenes"])
        print(f"  film {film['n']}  {t:5.1f}s  {film['title']}")


if __name__ == "__main__":
    main()
