// Screen-space geometry effects. Classic script, shared by the offline report.
(() => {
  'use strict';
  const candidates = {
    added:[[76,194,106],[6,60,20],[222,255,230]],
    removed:[[255,123,114],[95,5,5],[255,230,228]],
    modified:[[227,179,65],[70,38,0],[255,246,205]]
  };
  const styles = {added:{glyph:'+',dash:'solid',word:'Added'},
    removed:{glyph:'−',dash:'dashed',word:'Removed'},modified:{glyph:'~',dash:'dotted',word:'Modified'}};
  const luminance = rgb => rgb.map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; })
    .reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  function pickColor(action,bg) {
    return candidates[action].reduce((best,c)=>contrast(c,bg)>contrast(best,bg)?c:best);
  }
  const fragmentSource = `#version 300 es
precision highp float;
in vec2 uv;out vec4 outColor;
uniform sampler2D maskImage;
uniform vec2 size;
uniform float dpr,groupAlpha;
uniform vec3 markColor;
uniform int action,style;
float coverage(vec2 p){
  if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1))))return 0.;
  return texture(maskImage,p).r;
}
void main(){
  float own=coverage(uv),halo=0.,core=0.;
  for(int y=-2;y<=2;y++)for(int x=-2;x<=2;x++){
    vec2 delta=vec2(float(x),float(y));
    if(length(delta)>2.)continue;
    float edge=abs(coverage(uv+delta*dpr/size)-own);
    halo=max(halo,edge);
    if(length(delta)<=1.)core=max(core,edge);
  }
  vec2 css=gl_FragCoord.xy/dpr;
  float phase=mod(css.x+css.y,10.);
  float pattern=action==0?1.:action==1?step(phase,6.):
    (length(mod(css,vec2(6.))-vec2(3.))<1.5?1.:0.);
  if(style==1){
    if(action!=1||own<.5||mod(css.x+css.y,8.)>2.)discard;
    outColor=vec4(vec3(.035,.045,.06),.85*groupAlpha);return;
  }
  if(halo<.5)discard;
  outColor=vec4(vec3(.035,.045,.06),groupAlpha);
  if(core>.5&&pattern>.5)outColor=vec4(markColor,groupAlpha);
}`;
  window.BoardMarks = {styles,contrast,pickColor,fragmentSource};
})();
