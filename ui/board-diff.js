// Board comparison identity and visible-side routing. Classic script, no state ownership.
(() => {
  'use strict';
  const actionMap = rows => new Map(rows.map(row => [row.id, row.action]));
  const actionFor = (object, actions) => (object.changeIds || []).map(id => actions.get(id)).find(Boolean) || null;
  function sidesAt(mode, fraction, wipe, blend, scenes) {
    const order = mode === 'wipe' ? [fraction < wipe || wipe === 1 ? 'base' : 'head']
      : mode === 'blend' && blend === 0 ? ['base']
      : mode === 'blend' && blend === 1 ? ['head'] : ['head', 'base'];
    return order.filter(side => scenes[side]);
  }
  function pickFromHits(hits, afterId) {
    const choices = [], seen = new Set();
    for (const object of hits) for (const id of object.changeIds) {
      if (!seen.has(id)) { seen.add(id); choices.push({id, object}); }
    }
    if (!choices.length) return null;
    const index = choices.findIndex(choice => choice.id === afterId);
    return choices[(index + 1) % choices.length];
  }
  const weights = (mode, revision, action, blend) =>
    (mode === 'blend' && revision === 'head' ? blend : 1) * (mode === 'semantic' && !action ? .2 : 1);
  function clipRects(width, height, wipe) {
    const split = Math.round(width * Math.max(0, Math.min(1, wipe)));
    return {base:[0,0,split,height], head:[split,0,width-split,height]};
  }
  function target(gl, width, height) {
    const t = {texture:gl.createTexture(), framebuffer:gl.createFramebuffer(), stencil:gl.createRenderbuffer(), width, height};
    try {
      if (!t.texture || !t.framebuffer || !t.stencil) throw Error('Board diff allocation failed');
      gl.bindTexture(gl.TEXTURE_2D,t.texture);
      for (const name of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,name,gl.NEAREST);
      for (const name of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,name,gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      gl.bindFramebuffer(gl.FRAMEBUFFER,t.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t.texture,0);
      gl.bindRenderbuffer(gl.RENDERBUFFER,t.stencil);
      gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH24_STENCIL8,width,height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_STENCIL_ATTACHMENT,gl.RENDERBUFFER,t.stencil);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('Board diff framebuffer unavailable');
      return t;
    } catch (error) { deleteTarget(gl,t); throw error; }
  }
  function deleteTarget(gl,t) {
    gl.deleteTexture(t.texture); gl.deleteFramebuffer(t.framebuffer); gl.deleteRenderbuffer(t.stencil);
  }
  function compositor(gl) {
    const p = gl.createProgram(), shaders = [];
    try {
      for (const [type,source] of [[gl.VERTEX_SHADER,`#version 300 es
        out vec2 uv;
        void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`],
        [gl.FRAGMENT_SHADER,`#version 300 es
        precision highp float;
        in vec2 uv;out vec4 outColor;
        uniform sampler2D baseImage,headImage;
        uniform int mode;uniform float headAlpha;
        void main(){vec4 b=texture(baseImage,uv),h=texture(headImage,uv);
          if(mode==1){outColor=vec4(b.rgb*h.rgb,1.);return;}
          if(mode==2){outColor=b;return;}if(mode==3){outColor=h;return;}
          h*=headAlpha;outColor=h+b*(1.-h.a);}`]]) {
        const s = gl.createShader(type); shaders.push(s);
        gl.shaderSource(s,source); gl.compileShader(s);
        if (!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
        gl.attachShader(p,s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
      return p;
    } catch (error) { gl.deleteProgram(p); throw error; }
    finally { shaders.forEach(s=>gl.deleteShader(s)); }
  }
  function composite(pane, mode, alpha=1, clip=null) {
    const {gl} = pane.renderer, [base,head] = pane.targets;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,base.width,base.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST); gl.disable(gl.BLEND);
    gl.colorMask(true,true,true,true);
    if (clip) { gl.enable(gl.SCISSOR_TEST); gl.scissor(...clip); } else gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(pane.program); gl.bindVertexArray(pane.vao);
    for (const [i,t] of [base,head].entries()) {
      gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D,t.texture);
      gl.uniform1i(gl.getUniformLocation(pane.program,i?'headImage':'baseImage'),i);
    }
    gl.uniform1i(gl.getUniformLocation(pane.program,'mode'),mode);
    gl.uniform1f(gl.getUniformLocation(pane.program,'headAlpha'),alpha);
    gl.drawArrays(gl.TRIANGLES,0,3); gl.disable(gl.SCISSOR_TEST);
  }
  function mount({stage, scenes, changes, state, appearance, onLost, attachPanZoom}) {
    const panes = [], actions = actionMap(changes), sideMode = state.m === 'side';
    let disposed = false, frame = 0, observer = null, unsubscribe = null;
    const getAppearance = () => typeof appearance === 'function' ? appearance() : appearance.get();
    const controller = {
      panes,
      render() {
        if (disposed) return;
        try {
          const look = getAppearance(), bg = look.background || [0,16,35,1];
          const background = look.boardBackground || [bg[0]/255,bg[1]/255,bg[2]/255,bg[3] ?? 1];
          for (const pane of panes) {
            const {vp,canvas,renderer} = pane, {gl} = renderer;
            if (!vp.clientWidth || !vp.clientHeight || !(state.z > 0)) continue;
            const dpr = globalThis.devicePixelRatio || 1, width = Math.round(vp.clientWidth*dpr), height = Math.round(vp.clientHeight*dpr);
            renderer.setCamera({...state,width:vp.clientWidth,height:vp.clientHeight,dpr}); renderer.setAppearance(look);
            // Side is already one scene per canvas: no offscreen copy or compositor needed.
            if (sideMode) {
              renderer.setScene(pane.scenes[pane.sides[0]],pane.sides[0]);
              renderer.draw({background});
              continue;
            }
            if (!pane.targets || pane.targets[0].width !== width || pane.targets[0].height !== height) {
              pane.targets?.forEach(t=>deleteTarget(gl,t)); pane.targets = [];
              pane.targets.push(target(gl,width,height)); pane.targets.push(target(gl,width,height));
            }
            const mode = state.m;
            for (const [i,side] of ['base','head'].entries()) {
              const scene = pane.scenes[side], overlay = mode === 'overlay';
              renderer.setScene(scene,side);
              const options = {target:pane.targets[i], background:overlay ? [1,1,1,1] : i && mode !== 'wipe' && !sideMode ? [0,0,0,0] : background,
                grid: !overlay && (sideMode || mode === 'wipe' || i === 0)};
              if (overlay) options.override = (o,normal) => ({color:i?[.25,1,.25]:[1,.25,.25],opacity:normal.opacity});
              if (mode === 'semantic') {
                if (i === 0) {
                  renderer.setScene(scenes.head || scenes.base,'head');
                  renderer.draw({...options,filter:o=>!actionFor(o,actions),override:(o,normal)=>({...normal,opacity:normal.opacity*.2})});
                  renderer.setScene(scene,side);
                  renderer.draw({...options,clear:false,grid:false,filter:o=>!!actionFor(o,actions)});
                } else renderer.draw({...options,filter:o=>!!actionFor(o,actions)});
              } else renderer.draw(options);
            }
            if (sideMode) composite(pane,pane.sides[0] === 'base' ? 2 : 3);
            else if (mode === 'wipe') {
              composite(pane,2); composite(pane,3,1,clipRects(canvas.width,canvas.height,state.wipe).head);
            } else composite(pane,mode === 'overlay' ? 1 : 0,mode === 'blend' ? state.blend : 1);
          }
        } catch (error) { controller.dispose(); onLost?.(error); }
      },
      readPixel(index,x,y) {
        const {renderer,canvas} = panes[index], gl = renderer.gl, dpr = globalThis.devicePixelRatio || 1;
        const pixel = new Uint8Array(4); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        gl.readPixels(Math.floor(x*dpr),canvas.height-1-Math.floor(y*dpr),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        return pixel;
      },
      dispose() {
        if (disposed) return; disposed = true;
        if (frame) cancelAnimationFrame(frame); observer?.disconnect(); unsubscribe?.();
        for (const pane of panes) {
          const gl = pane.renderer.gl;
          pane.targets?.forEach(t=>deleteTarget(gl,t)); gl.deleteProgram(pane.program); gl.deleteVertexArray(pane.vao); pane.renderer.dispose();
        }
      }
    };
    try {
      for (const sides of sideMode ? [['base'],['head']] : [['base','head']]) {
        const vp = document.createElement('div'), canvas = document.createElement('canvas'), hud = document.createElement('div');
        vp.className = 'vp board'; vp.dataset.boardGl = ''; if (sideMode) vp.dataset.side = sides[0];
        canvas.className = 'board-gl'; canvas.setAttribute('aria-label',`${sides.join(' and ')} board`);
        hud.className = 'board-hud'; vp.append(canvas,hud);
        const label = document.createElement('span'); label.className = 'tag';
        label.textContent = sideMode ? (sides[0] === 'base' ? 'Base' : 'Head') + (!scenes[sides[0]] ? ' — not present' : '')
          : state.m === 'overlay' ? 'Base (red) · Head (green) · both (black)' : state.m === 'semantic' ? 'Changes only' : 'Base under Head';
        if (!sideMode && state.m === 'overlay') label.innerHTML = '<i class="sw del"></i>Base (red) · <i class="sw add"></i>Head (green) · <i class="sw both"></i>both (black)';
        vp.append(label); stage.append(vp); attachPanZoom?.(vp);
        const renderer = BoardGL.create(canvas,{retained:true,manual:true,onFailure:onLost});
        if (!renderer) throw Error('WebGL2 unavailable');
        const pane = {vp,canvas,renderer,scenes:sideMode ? {[sides[0]]:scenes[sides[0]]} : scenes,sides,targets:null,program:null,vao:null};
        panes.push(pane); pane.program = compositor(renderer.gl); pane.vao = renderer.gl.createVertexArray();
        renderer.project = point => renderer.worldToScreen(point);
      }
      observer = new ResizeObserver(() => { if (!frame && !disposed) frame = requestAnimationFrame(() => { frame = 0; controller.render(); }); });
      panes.forEach(p=>observer.observe(p.vp));
      if (appearance.subscribe) unsubscribe = appearance.subscribe(()=>controller.render());
      return controller;
    } catch (error) { controller.dispose(); throw error; }
  }
  window.BoardDiff = {actionMap, actionFor, sidesAt, pickFromHits, weights, clipRects, mount};
})();
