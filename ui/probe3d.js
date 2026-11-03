// Injected before page scripts. Hooks WebGL, counts frames and draw calls, records long tasks.
(() => {
  if (self.__probe) return;
  const P = self.__probe = { shaders: [], draws: 0, instanced: 0, frames: [], uploads: { buffer: 0, texture: 0, compressed: 0 },
    ext: new Set(), longTasks: [], contexts: [], offscreen: 0, firstDraw: null, from: 0, clickAt: 0 };
  try { new PerformanceObserver(l => l.getEntries().forEach(e => P.longTasks.push([Math.round(e.startTime), Math.round(e.duration)])))
    .observe({ type: 'longtask', buffered: true }); } catch {}
  const after = (proto, name, fn) => { const orig = proto?.[name]; if (typeof orig !== 'function') return;
    proto[name] = function (...a) { const r = orig.apply(this, a); try { fn.call(this, a, r); } catch {} return r; }; };
  const types = new WeakMap(), draw = () => { P.draws++; P.firstDraw ??= performance.now(); };
  for (const C of [self.WebGLRenderingContext, self.WebGL2RenderingContext]) {
    const p = C?.prototype; if (!p) continue;
    after(p, 'createShader', (a, r) => types.set(r, a[0] === 0x8B31 ? 'vertex' : 'fragment'));
    after(p, 'shaderSource', a => P.shaders.push({ type: types.get(a[0]), src: a[1] }));
    for (const n of ['drawElements', 'drawArrays', 'drawRangeElements']) after(p, n, draw);
    for (const n of ['drawElementsInstanced', 'drawArraysInstanced']) after(p, n, () => { draw(); P.instanced++; });
    after(p, 'bufferData', a => { P.uploads.buffer += typeof a[1] === 'number' ? a[1] : a[1]?.byteLength || 0; });
    after(p, 'texImage2D', a => { const s = a.length >= 8 ? [a[3], a[4]] : [a[5]?.width || a[5]?.videoWidth || 0, a[5]?.height || a[5]?.videoHeight || 0];
      P.uploads.texture += s[0] * s[1] * 4; });
    after(p, 'texStorage2D', a => { P.uploads.texture += a[3] * a[4] * 4 * (a[1] > 1 ? 4 / 3 : 1); });
    after(p, 'compressedTexImage2D', a => { P.uploads.compressed += a.find(x => ArrayBuffer.isView(x))?.byteLength || 0; });
    after(p, 'getExtension', (a, r) => { if (r) P.ext.add(a[0]); });
  }
  for (const C of [self.HTMLCanvasElement, self.OffscreenCanvas])
    after(C?.prototype, 'getContext', function (a, r) { if (r && !P.contexts.some(c => c.ctx === r)) P.contexts.push({ type: a[0], ctx: r, canvas: this }); });
  after(self.HTMLCanvasElement?.prototype, 'transferControlToOffscreen', () => { P.offscreen++; });
  let last = 0, lastDraws = 0;
  const loop = t => { if (last) P.frames.push([Math.round(t), +(t - last).toFixed(2), P.draws - lastDraws]);
    last = t; lastDraws = P.draws; if (P.frames.length > 60000) P.frames.splice(0, 30000); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  P.mark = () => { P.from = performance.now(); };
  P.stats = () => {
    const f = P.frames.filter(x => x[0] >= P.from), iv = f.map(x => x[1]).sort((a, b) => a - b), secs = (performance.now() - P.from) / 1000,
      q = p => iv.length ? iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] : null, drawn = f.filter(x => x[2] > 0);
    return { seconds: +secs.toFixed(2), frames: f.length, fps: +(f.length / secs).toFixed(1), drawnFrames: drawn.length,
      drawFps: +(drawn.length / secs).toFixed(1), medianMs: q(.5), p95Ms: q(.95), maxMs: iv.at(-1) ?? null,
      drawCallsPerDrawnFrame: median(drawn.map(x => x[2])), longTasks: P.longTasks.filter(t => t[0] >= P.from) };
  };
  P.summary = () => {
    const ext = [...P.ext], gl = P.contexts.find(c => /webgl/.test(c.type))?.ctx;
    let gpu = null; try { const e = gl?.getExtension('WEBGL_debug_renderer_info'); gpu = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : null; } catch {}
    const drawn = P.frames.filter(x => x[0] >= P.clickAt && x[2] > 0), peak = Math.max(0, ...drawn.map(x => x[2])),
      usable = drawn.find(x => x[2] >= .9 * peak);
    return {
      engine: { three: self.__THREE__ || null, babylon: self.BABYLON?.Engine?.Version || null, playcanvas: self.pc?.version || null, filament: !!self.Filament },
      contexts: P.contexts.map(c => ({ type: c.type, attrs: c.ctx.getContextAttributes?.() || null,
        css: [c.canvas.clientWidth ?? null, c.canvas.clientHeight ?? null], buffer: [c.canvas.width, c.canvas.height] })),
      offscreen: P.offscreen, extensions: ext, gpu, shaders: P.shaders.length, draws: P.draws, instancedDraws: P.instanced, uploads: P.uploads,
      firstDrawMs: P.firstDraw && Math.round(P.firstDraw), usableMs: usable ? Math.round(usable[0] - P.clickAt) : null, firstDrawnAfterClickMs: drawn.length ? Math.round(drawn[0][0] - P.clickAt) : null, peakDrawCalls: peak,
      dom: { elements: document.getElementsByTagName('*').length, svgs: document.querySelectorAll('svg').length,
        svgElements: document.querySelectorAll('svg *').length, canvases: [...document.querySelectorAll('canvas')].map(c => [c.width, c.height]),
        bigImages: [...document.images].filter(i => i.naturalWidth > 512).map(i => [i.currentSrc.slice(0, 160), i.naturalWidth, i.naturalHeight]) },
      links: [...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => h.startsWith(location.origin)))].slice(0, 200),
      longTasks: P.longTasks.length, longTaskMs: P.longTasks.reduce((s, t) => s + t[1], 0)
    };
  };
})();
