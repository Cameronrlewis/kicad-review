import hashlib, importlib.util, json, math, pathlib, shutil, subprocess, sys
import pcbnew
script,root,fixture=map(pathlib.Path,sys.argv[1:4]); root.mkdir(parents=True,exist_ok=True)
def point(x,y): return pcbnew.VECTOR2I(int(x*1e6),int(y*1e6))
def polygon(poly,points,hole=None):
    for x,y in points:
        if hole is None: poly.Append(int(x*1e6),int(y*1e6))
        else: poly.Append(int(x*1e6),int(y*1e6),0,hole)
def rectangle(board,net,layer,x0,y0,x1,y1,hole=False):
    z=pcbnew.ZONE(board);z.SetLayer(layer);z.SetNetCode(net.GetNetCode())
    z.SetLocalClearance(0);z.SetMinThickness(10000);z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_NEVER)
    p=z.Outline();p.NewOutline();polygon(p,[(x0,y0),(x1,y0),(x1,y1),(x0,y1)])
    if hole:
        p.NewHole(0);polygon(p,[(3,3),(3,4),(4,4),(4,3)],0)
    board.Add(z);return z
board=pcbnew.LoadBoard(str(fixture))
for item in list(board.GetTracks()): board.RemoveNative(item)
for a,b in [((0,0),(20,0)),((20,0),(20,20)),((20,20),(0,20)),((0,20),(0,0))]:
    edge=pcbnew.PCB_SHAPE(board);edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
    edge.SetStart(point(*a));edge.SetEnd(point(*b));edge.SetLayer(pcbnew.Edge_Cuts);edge.SetWidth(50000);board.Add(edge)
gnd=pcbnew.NETINFO_ITEM(board,'GND');board.Add(gnd)
other=pcbnew.NETINFO_ITEM(board,'OTHER');board.Add(other)
fp=pcbnew.FOOTPRINT(board);fp.SetReference('U1');board.Add(fp)
def pad(net,x,y,size):
    p=pcbnew.PAD(fp);p.SetNumber(str(fp.GetPadCount()+1));p.SetShape(pcbnew.PAD_SHAPE_RECT)
    l=pcbnew.LSET();l.AddLayer(pcbnew.F_Cu)
    p.SetAttribute(pcbnew.PAD_ATTRIB_SMD);p.SetLayerSet(l)
    p.SetPosition(point(x,y));p.SetSize(point(size,size));p.SetNetCode(net.GetNetCode());fp.Add(p);return p
pad(gnd,8,6,2);foreign=pad(other,15,15,1)
track=pcbnew.PCB_TRACK(board);track.SetStart(point(7,3));track.SetEnd(point(10,3))
track.SetWidth(1000000);track.SetLayer(pcbnew.F_Cu);track.SetNetCode(gnd.GetNetCode());board.Add(track)
rectangle(board,gnd,pcbnew.F_Cu,2,2,8,6,True)
rectangle(board,gnd,pcbnew.In1_Cu,3,10,5,12)
base=root/'base';head=root/'head';stale=root/'stale'
for directory in (base,head,stale):directory.mkdir(exist_ok=True)
pro={'board':{'design_settings':{'rules':{'min_clearance':0.1}}}}
board.BuildConnectivity();pcbnew.ZONE_FILLER(board).Fill(board.Zones())
pcbnew.SaveBoard(str(base/'p.kicad_pcb'),board)
for directory in (base,head,stale):
    (directory/'p.kicad_pro').write_text(json.dumps(pro))
    (directory/'p.kicad_dru').write_text('(version 1)\n')
shutil.copy2(base/'p.kicad_pcb',head/'p.kicad_pcb')
h=pcbnew.LoadBoard(str(head/'p.kicad_pcb'))
for z in h.Zones():
    if z.IsOnLayer(pcbnew.In1_Cu): z.Move(point(1,0))
pcbnew.SaveBoard(str(head/'p.kicad_pcb'),h)
st=pcbnew.LoadBoard(str(base/'p.kicad_pcb'))
st.BuildConnectivity();pcbnew.ZONE_FILLER(st).Fill(st.Zones())
for z in st.Zones():z.UnFill()
pcbnew.SaveBoard(str(stale/'p.kicad_pcb'),st)
def hashes():
    return {str(p):hashlib.sha256(p.read_bytes()).hexdigest() for d in (base,head,stale)
            for p in d.iterdir() if p.suffix in ('.kicad_pcb','.kicad_pro','.kicad_dru')}
before=hashes()
# Project/custom-rule oracle: exactly identical PCB bytes, different adjacent constraints.
foreign.SetPosition(point(5,5));pcbnew.SaveBoard(str(root/'context.kicad_pcb'),board)
areas={}
for label,clearance,custom in [('project-lo',.1,None),('project-hi',.5,None),
                                ('custom-lo',.1,.2),('custom-hi',.1,.8)]:
    source=root/label;source.mkdir(exist_ok=True)
    shutil.copy2(root/'context.kicad_pcb',source/'p.kicad_pcb')
    pro['board']['design_settings']['rules']['min_clearance']=clearance
    (source/'p.kicad_pro').write_text(json.dumps(pro))
    (source/'p.kicad_dru').write_text('(version 1)\n'+
        ('(rule "BR03" (constraint clearance (min '+str(custom)+'mm)))\n' if custom is not None else ''))
    original={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}
    # KiCad CLI establishes project context. The new --save-board flag is an explicit two-version gate.
    oracle=root/(label+'-oracle');shutil.copytree(source,oracle,dirs_exist_ok=True)
    cmd=['kicad-cli','pcb','drc','--format','json','--severity-error','--exit-code-violations',
         '--refill-zones','--save-board','-o',str(oracle/'drc.json'),str(oracle/'p.kicad_pcb')]
    run=subprocess.run(cmd,capture_output=True,text=True,timeout=55);assert run.returncode in (0,5),run.stderr
    ob=pcbnew.LoadBoard(str(oracle/'p.kicad_pcb'))
    # Inspect settings; raw standalone LoadBoard is recorded, never assumed to load this project.
    print(label,'standalone minimum',pcbnew.LoadBoard(str(source/'p.kicad_pcb')).GetDesignSettings().m_MinClearance)
    raw=next(z for z in ob.Zones() if z.IsOnLayer(pcbnew.F_Cu)).GetFilledPolysList(pcbnew.F_Cu)
    # Compare union including the same-net pad/track, not zone area to whole-net area.
    for item in [*ob.GetTracks(),*ob.GetPads()]:
        if item.IsOnLayer(pcbnew.F_Cu) and item.GetNetname()=='GND':
            pp=pcbnew.SHAPE_POLY_SET();item.TransformShapeToPolygon(pp,pcbnew.F_Cu,0,5000,pcbnew.ERROR_INSIDE);raw.BooleanAdd(pp)
    raw.Simplify()
    areas[label]=raw.Area()/1e12
    assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}==original
for lo,hi in [('project-lo','project-hi'),('custom-lo','custom-hi')]:
    assert (root/lo/'p.kicad_pcb').read_bytes()==(root/hi/'p.kicad_pcb').read_bytes()
    assert abs(areas[lo]-areas[hi])>.05, 'BR03 '+lo+' context ignored'
assert hashes()==before
print('BR03 independent CLI context oracle PASS',areas)
(root/'source-sha256.json').write_text(json.dumps({'before':before,'after':hashes()},indent=2))
