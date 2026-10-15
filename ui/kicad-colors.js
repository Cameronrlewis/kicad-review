// PCB drawing data: KiCad 10 revision 3e051f88. See NOTICE.
(() => {
  const layers = {"F.Cu":[200,52,52,1], "B.Cu":[77,127,196,1]};
  // KiCad 3e051f88 common/settings/builtin_color_themes.h:181-212
  const inner = [
    [127,200,127],[206,125,44],[79,203,203],[219,98,139],
    [167,165,198],[40,204,217],[232,178,167],[242,237,161],
    [141,203,129],[237,124,51],[91,195,235],[247,111,142],
    [167,165,198],[40,204,217],[232,178,167],[242,237,161],
    [237,124,51],[91,195,235],[247,111,142],[167,165,198],
    [40,204,217],[232,178,167],[242,237,161],[237,124,51],
    [91,195,235],[247,111,142],[167,165,198],[40,204,217],
    [232,178,167],[242,237,161]
  ];
  inner.forEach((rgb,i) => layers[`In${i+1}.Cu`] = [...rgb,1]);
  // builtin_color_themes.h:214-231
  Object.assign(layers, {
    "F.Adhes":[132,0,132,1], "B.Adhes":[0,0,132,1],
    "F.Paste":[180,160,154,.9], "B.Paste":[0,194,194,.9],
    "F.SilkS":[242,237,161,1], "B.SilkS":[232,178,167,1],
    "F.Mask":[216,100,255,.4], "B.Mask":[2,255,238,.4],
    "Dwgs.User":[194,194,194,1], "Cmts.User":[89,148,220,1],
    "Eco1.User":[180,219,210,1], "Eco2.User":[216,200,82,1],
    "Edge.Cuts":[208,210,205,1], "Margin":[255,38,226,1],
    "F.CrtYd":[255,38,226,1], "B.CrtYd":[38,233,255,1],
    "F.Fab":[175,175,175,1], "B.Fab":[88,93,132,1]
  });
  // builtin_color_themes.h:232-276. User.9 is an exception.
  const user = [[194,194,194],[89,148,220],[180,219,210],[216,200,82]];
  for (let i=1;i<=45;i++) layers[`User.${i}`] = [...(i===9?[232,178,167]:user[(i-1)%4]),1];
  // builtin_color_themes.h:156-179, all PCB non-layer defaults.
  const objects = {
    anchor:[255,38,226,1], lockedShadow:[255,38,226,.5],
    conflictsShadow:[255,0,5,.5], auxItems:[255,255,255,1],
    background:[0,16,35,1], cursor:[255,255,255,1],
    drcError:[215,91,107,.8], drcWarning:[255,208,66,.8],
    drcExclusion:[255,255,255,.8], grid:[132,132,132,1],
    gridAxes:[194,194,194,1], platedHoles:[194,194,0,1],
    nonPlatedHoles:[26,196,210,1], ratsnest:[0,248,255,.35],
    selection:[4,255,67,1], viaHoles:[227,183,46,1],
    viaHolewalls:[236,236,236,1], drawingSheet:[200,114,171,1],
    pageLimits:[132,132,132,1], boardArea:[100,100,100,.35],
    netnames:[255,255,255,.7], padNetnames:[255,255,255,.9],
    viaNetnames:[50,50,50,.9], points:[255,38,226,1]
  };
  // pcbnew/widgets/appearance_controls.cpp:1750-1820, copper stack loop:1860-1882.
  const tech = ["F.Adhes","B.Adhes","F.Paste","B.Paste","F.SilkS","B.SilkS",
    "F.Mask","B.Mask","Dwgs.User","Cmts.User","Eco1.User","Eco2.User",
    "Edge.Cuts","Margin","F.CrtYd","B.CrtYd","F.Fab","B.Fab"];
  const users = Array.from({length:45},(_,i)=>`User.${i+1}`);
  const copper = ["F.Cu",...inner.map((_,i)=>`In${i+1}.Cu`),"B.Cu"];
  const appearanceOrder = [...copper,...tech,...users];
  // Draw priority is NOT Appearance order. Values express top-to-bottom roles.
  // Painters reverse this list; zones precede other objects on their layer,
  // and pad/via copper precedes drill overlays. Promote the selected side's
  // family, then its selected layer, without covering holes or review overlays.
  // Selecting B.Cu does not flip the view.
  // pcbnew/pcb_draw_panel_gal.cpp:66-297, active-side promotion:585-635.
  const drawPriority = ["overlay","netnames","Dwgs.User","Cmts.User","Eco1.User",
    "Eco2.User","Edge.Cuts","Margin",...users,"text","ratsnest","holes",
    "F.Cu","F.Mask","F.SilkS","F.Paste","F.Adhes","F.CrtYd","F.Fab",
    ...inner.map((_,i)=>`In${i+1}.Cu`),
    "B.Cu","B.Mask","B.SilkS","B.Paste","B.Adhes","B.CrtYd","B.Fab",
    "drawingSheet","grid"];
  globalThis.KicadColors = {layers,objects,appearanceOrder,drawPriority};
})();
