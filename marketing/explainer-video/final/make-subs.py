#!/usr/bin/env python3
"""Writes the subtitle track from the same edit list the film is built from.

Cue times are computed the way build.py computes scene starts, so the captions cannot drift out of
sync with the picture - both read the measured narration durations, not a hand-kept timing sheet.

Long lines are split at their internal punctuation rather than at a fixed word count, so a cue
always breaks where the narrator actually pauses.

  python3 make-subs.py     -> CVApplyr-Explainer.srt and .vtt
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
XFADE = 0.30
HEAD, TAIL = 0.15, 0.45      # the silent pad gen-vo.py puts on each line
MAX_CHARS = 78               # two comfortable lines on a phone


def clock(t, comma=True):
    h, rem = divmod(max(t, 0), 3600)
    m, s = divmod(rem, 60)
    ms = int(round((s - int(s)) * 1000))
    sep = "," if comma else "."
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d}{sep}{ms:03d}"


def split_line(text):
    """Break a long line at its strongest internal punctuation, else at the midpoint word."""
    if len(text) <= MAX_CHARS:
        return [text]
    parts = re.split(r"(?<=[.!?]) +", text)
    if len(parts) > 1:
        out, buf = [], ""
        for p in parts:
            if buf and len(buf) + len(p) + 1 > MAX_CHARS:
                out.append(buf); buf = p
            else:
                buf = f"{buf} {p}".strip()
        if buf:
            out.append(buf)
        return [c for part in out for c in (split_line(part) if len(part) > MAX_CHARS else [part])]
    for sep in (", ", " - ", " — "):
        if sep in text:
            i = text.rfind(sep, 0, len(text) // 2 + len(sep) + 12)
            if i > 12:
                return [text[:i + len(sep) - 1].strip(), text[i + len(sep):].strip()]
    w = text.split()
    h = len(w) // 2
    return [" ".join(w[:h]), " ".join(w[h:])]


def main():
    cfg = json.load(open(os.path.join(HERE, "scenes.json")))
    vo = json.load(open(os.path.join(HERE, "vo", "durations.json")))["durations"]

    cues, t = [], 0.0
    for sc in cfg["scenes"]:
        d = vo[sc["id"]]
        speech_start, speech_end = t + HEAD, t + d - TAIL
        chunks = split_line(sc["vo"].strip())
        # Share the line's speaking time across its chunks by character count - close enough to
        # speech rate that no cue lands early or lingers.
        total = sum(len(c) for c in chunks) or 1
        cur = speech_start
        for c in chunks:
            span = (speech_end - speech_start) * (len(c) / total)
            cues.append((cur, cur + span, c))
            cur += span
        t += d - XFADE

    srt = "".join(f"{i}\n{clock(a)} --> {clock(b)}\n{txt}\n\n"
                  for i, (a, b, txt) in enumerate(cues, 1))
    open(os.path.join(HERE, "CVApplyr-Explainer.srt"), "w").write(srt)

    vtt = "WEBVTT\n\n" + "".join(f"{clock(a, False)} --> {clock(b, False)}\n{txt}\n\n"
                                 for a, b, txt in cues)
    open(os.path.join(HERE, "CVApplyr-Explainer.vtt"), "w").write(vtt)
    print(f"{len(cues)} cues, ending {clock(cues[-1][1])}")


if __name__ == "__main__":
    main()
