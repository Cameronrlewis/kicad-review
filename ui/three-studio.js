window.ThreeStudio=(()=>{
// BoardRepo "studio-light" environment generator (de-minified; constants verbatim).
const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

const WARM = [1, .98, .94], COOL = [.74, .83, 1];
const UNDER = { az: 255, el: -42, widthAz: 96, widthEl: 50, feather: 24, color: [.78, .86, 1], intensity: 3.2 };
const GLINTS = [
  { az: 115, el: 14, widthAz: 14, widthEl: 8, feather: 4, color: [1, .98, .95], intensity: 34 },
  { az: 275, el: 38, widthAz: 10, widthEl: 7, feather: 3, color: [1, .99, .97], intensity: 30 },
  { az: 50,  el: 20, widthAz: 9,  widthEl: 6, feather: 3, color: [.95, .97, 1], intensity: 22 },
];
const LIGHT_RIGS = {
  bench:  { boxes: [{ az: 0, el: 55, widthAz: 58, widthEl: 34, feather: 14, color: WARM, intensity: 11 },
                    { az: 190, el: 24, widthAz: 80, widthEl: 40, feather: 22, color: COOL, intensity: 1.6 }, UNDER, ...GLINTS],
            ambient: { floor: .06, ceiling: .15 } },
  lowsun: { boxes: [{ az: 0, el: 28, widthAz: 40, widthEl: 22, feather: 8, color: [1, .99, .97], intensity: 16 },
                    { az: 180, el: 18, widthAz: 90, widthEl: 36, feather: 20, color: COOL, intensity: 2.2 }, UNDER, ...GLINTS],
            ambient: { floor: .075, ceiling: .17 } },
  photo:  { boxes: [{ az: 0, el: 62, widthAz: 96, widthEl: 50, feather: 26, color: WARM, intensity: 3.6 },
                    { az: 180, el: 32, widthAz: 84, widthEl: 44, feather: 24, color: [.86, .9, 1], intensity: 1.4 }, UNDER, ...GLINTS],
            ambient: { floor: .085, ceiling: .2 } },
};
const PRESETS = {
  bench:  { rig: "bench",  bearing: 60, exposure: 1.35, tone: "neutral" },   // default
  lowsun: { rig: "lowsun", bearing: 60, exposure: 1.6,  tone: "neutral" },
  photo:  { rig: "photo",  bearing: 60, exposure: 1.2,  tone: "commerce" },  // "commerce" falls back to Neutral in r183
};
const EXPOSURE_RANGE = { min: .4, max: 3, step: .05 };
const snapBearing = b => (30 * Math.round(b / 30) % 360 + 360) % 360;   // "Light from" dial, 30° steps

// Returns linear RGB for one direction (azimuth az, elevation el, degrees).
function radiance(rig, bearing, az, el) {
  const amb = rig.ambient.floor + (rig.ambient.ceiling - rig.ambient.floor) * smoothstep(.3, 1, (el + 90) / 180);
  let r = .94 * amb, g = .98 * amb, b = 1.06 * amb;
  for (const box of rig.boxes) {
    const centre = ((270 - bearing + box.az) % 360 + 360) % 360;
    const dAz = Math.abs((az - centre + 540) % 360 - 180), dEl = Math.abs(el - box.el);
    const w = (1 - smoothstep(box.widthAz / 2 - box.feather, box.widthAz / 2 + box.feather, dAz))
            * (1 - smoothstep(box.widthEl / 2 - box.feather, box.widthEl / 2 + box.feather, dEl)) * box.intensity;
    r += box.color[0] * w; g += box.color[1] * w; b += box.color[2] * w;
  }
  return [r, g, b];
}
function pixels(name,bearing,w=256,h=128) {
  const rig=LIGHT_RIGS[name]||LIGHT_RIGS.bench,out=new Float32Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    const el=90-180/h*(y+.5),rgb=radiance(rig,bearing,360/w*(x+.5),el);
    out.set([...rgb,1],((h-1-y)*w+x)*4);
  }
  return out;
}
return {LIGHT_RIGS,PRESETS,radiance,snapBearing,pixels};
})();
