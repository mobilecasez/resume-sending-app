#!/usr/bin/env python3
"""Generate the narration track, one WAV per scene, via Gemini TTS.

Every line goes out with the SAME delivery direction so fourteen separate API calls come back
sounding like one person in one session rather than fourteen takes. The returned audio is raw
16-bit PCM at 24 kHz, so we write the WAV header ourselves, then let ffmpeg trim the dead air off
each end and level the whole set to a single loudness target.

The measured duration of each line is what times the film - see build.py. Nothing here assumes a
scene length.

  python3 gen-vo.py                # all scenes, voice from scenes.json
  python3 gen-vo.py --voice Iapetus --out vo-alt   # a different read to compare
  python3 gen-vo.py --only 04,11   # re-record just these lines
"""
import argparse, base64, json, os, struct, subprocess, sys, urllib.request, time

HERE = os.path.dirname(os.path.abspath(__file__))
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
MODEL = "gemini-3.1-flash-tts-preview"

# One direction, prepended to every line. Naming the product's pronunciation matters: left alone,
# "CVApplyr" gets read as a single mangled word instead of the letters plus "applier".
DIRECTION = (
    "You are the host of a short software product explainer. Read the line below calmly and "
    "conversationally, like you are showing a friend a shortcut - not selling anything. Natural "
    "unhurried pace, warm mid-pitch, neutral international English, no advertising lilt and no "
    "rising excitement at the end. Pronounce 'CVApplyr' as 'C V Applier'. Read only the line, "
    "nothing else.\n\nLine: "
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
    sys.exit("No Gemini key. Put it in final/.gemini-key or export GEMINI_API_KEY.")


def tts(text, voice, key, tries=4):
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
            with urllib.request.urlopen(req, timeout=180) as r:
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


def dur(path):
    return float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "csv=p=0", path], capture_output=True, text=True).stdout.strip())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice")
    ap.add_argument("--out", default="vo")
    ap.add_argument("--only", default="")
    a = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, "scenes.json")))
    voice = a.voice or cfg.get("voice", "Charon")
    outdir = os.path.join(HERE, a.out)
    os.makedirs(outdir, exist_ok=True)
    key = api_key()
    only = {s.strip() for s in a.only.split(",") if s.strip()}

    manifest, total = {}, 0.0
    for sc in cfg["scenes"]:
        sid, raw = sc["id"], os.path.join(outdir, f"{sc['id']}.raw.wav")
        final = os.path.join(outdir, f"{sid}.wav")
        if only and sid not in only:
            if os.path.exists(final):
                d = dur(final); manifest[sid] = d; total += d
            continue
        print(f"  [{sid}] {voice}: {sc['vo'][:58]}...", flush=True)
        write_wav(raw, tts(sc["vo"], voice, key))
        # Trim the silence the model pads on, level every line to the same loudness, then give
        # each line a fixed 0.15s head and 0.45s tail so scenes never collide at the splice.
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
        d = dur(final); manifest[sid] = d; total += d
        print(f"       -> {d:.2f}s", flush=True)

    json.dump({"voice": voice, "durations": manifest, "total": total},
              open(os.path.join(outdir, "durations.json"), "w"), indent=2)
    print(f"\n{len(manifest)} lines, {total:.1f}s total ({total/60:.1f} min), voice={voice}")


if __name__ == "__main__":
    main()
