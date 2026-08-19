// The résumé-score ring is drawn WITHOUT react-native-svg (this project has no such dependency):
// two clipped halves of a bordered circle, each rotated. That geometry is easy to get subtly wrong
// — an arc that reads 70 when the score is 61 is a lie told confidently on someone's home screen —
// so the interpolation is asserted here rather than eyeballed on a device.
//
// The rotations are READ OUT OF THE COMPONENT, not restated, so this fails if the component drifts.
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../components/ResumeScoreModal.tsx', 'utf8');

const range = (name) => {
  const m = src.match(new RegExp(name + String.raw`\s*=\s*deg\.interpolate\(\{\s*inputRange:\s*\[([^\]]+)\],\s*outputRange:\s*\[([^\]]+)\]`));
  if (!m) throw new Error('could not read ' + name + ' out of ResumeScoreModal.tsx');
  return {
    inR: m[1].split(',').map((v) => parseFloat(v)),
    outR: m[2].split(',').map((v) => parseFloat(String(v).replace(/[^\d.-]/g, ''))),
  };
};
const RIGHT = range('rightRotate');
const LEFT = range('leftRotate');

const lerp = (x, { inR, outR }) => {
  for (let i = 0; i < inR.length - 1; i++) {
    if (x <= inR[i + 1]) { const t = (x - inR[i]) / (inR[i + 1] - inR[i]); return outR[i] + t * (outR[i + 1] - outR[i]); }
  }
  return outR[outR.length - 1];
};
const norm = (a) => ((a % 360) + 360) % 360;
// A circle with ONLY its top and right borders coloured paints the arc [315°, 135°) in its own
// frame (0° = twelve o'clock, clockwise). Rotating the element by `rot` carries that arc with it.
// Half-open so the two halves cannot both claim the shared boundary.
const painted = (theta, rot) => { const rel = norm(theta - rot); return rel >= 315 || rel < 135; };

// Sample the full circle: the RIGHT element is only visible through the 0°–180° clip, the LEFT
// element only through the 180°–360° clip. Total painted degrees must equal the progress.
const STEP = 0.25;
const drawn = (deg) => {
  let n = 0;
  for (let t = 0; t < 360; t += STEP) if (t < 180 ? painted(t, lerp(deg, RIGHT)) : painted(t, lerp(deg, LEFT))) n++;
  return n * STEP;
};

let pass = 0, fail = 0;
for (let score = 0; score <= 100; score++) {
  const deg = (score / 100) * 360;
  const got = drawn(deg);
  if (Math.abs(got - deg) <= STEP) pass++;
  else { fail++; console.log(`  ✗ score ${score} → wanted ${deg.toFixed(2)}° painted, got ${got.toFixed(2)}°`); }
}
// The two seams are where a clipped-halves ring actually breaks, so they are asserted explicitly.
const seam = (deg, want) => {
  const got = drawn(deg);
  if (Math.abs(got - want) <= STEP) pass++;
  else { fail++; console.log(`  ✗ seam at ${deg}° → wanted ${want}°, got ${got.toFixed(2)}°`); }
};
seam(0, 0); seam(179.5, 179.5); seam(180, 180); seam(180.5, 180.5); seam(360, 360);

console.log(`\nscore ring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
