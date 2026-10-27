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
if '--fixture-only' in sys.argv:
    print('BR03 fixture API gate PASS');sys.exit(0)
spec=importlib.util.spec_from_file_location('copper',str(script))
copper=importlib.util.module_from_spec(spec);spec.loader.exec_module(copper)
b=copper.collect(str(base/'p.kicad_pcb'));h=copper.collect(str(head/'p.kicad_pcb'))
# Zone area 24 minus 1 mm² hole; pad protrudes 3; track protrudes 2 + semicircle pi/8.
expected=24-1+3+2+math.pi/8
assert abs(b[('F.Cu','GND')].Area()/1e12-expected)<0.03, 'BR03 collect lost/duplicated primitive'
assert abs(b[('F.Cu','OTHER')].Area()/1e12-1)<1e-6, 'BR03 mixed nets'
assert b[('F.Cu','GND')].HoleCount(0)>=1
rows=copper.compare(b,h)['rows']
assert len(rows)==1 and rows[0]['layer']=='In1.Cu'
assert abs(rows[0]['addedMm2']-2)<0.03 and abs(rows[0]['removedMm2']-2)<0.03
assert rows[0]['addedContours'] and rows[0]['removedContours']
assert not copper.compare(b,copper.collect(str(stale/'p.kicad_pcb')))['rows'], 'BR03 stale fills changed result'
assert hashes()==before, 'BR03 source project mutated'
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
    run=subprocess.run(cmd,capture_output=True,text=True);assert run.returncode in (0,5),run.stderr
    ob=pcbnew.LoadBoard(str(oracle/'p.kicad_pcb'))
    # Inspect settings; raw standalone LoadBoard is recorded, never assumed to load this project.
    print(label,'standalone minimum',pcbnew.LoadBoard(str(source/'p.kicad_pcb')).GetDesignSettings().m_MinClearance)
    raw=next(z for z in ob.Zones() if z.IsOnLayer(pcbnew.F_Cu)).GetFilledPolysList(pcbnew.F_Cu)
    produced=copper.collect(str(source/'p.kicad_pcb'))[('F.Cu','GND')]
    # Compare union including the same-net pad/track, not zone area to whole-net area.
    for item in [*ob.GetTracks(),*ob.GetPads()]:
        if item.IsOnLayer(pcbnew.F_Cu) and item.GetNetname()=='GND':
            pp=pcbnew.SHAPE_POLY_SET();item.TransformShapeToPolygon(pp,pcbnew.F_Cu,0,5000,pcbnew.ERROR_INSIDE);raw.BooleanAdd(pp)
    raw.Simplify()
    delta=pcbnew.SHAPE_POLY_SET(raw);delta.BooleanSubtract(produced)
    reverse=pcbnew.SHAPE_POLY_SET(produced);reverse.BooleanSubtract(raw)
    assert (delta.Area()+reverse.Area())/1e12<1e-6, 'BR03 project context differs from CLI'
    areas[label]=produced.Area()/1e12
    assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir()}==original
for lo,hi in [('project-lo','project-hi'),('custom-lo','custom-hi')]:
    assert (root/lo/'p.kicad_pcb').read_bytes()==(root/hi/'p.kicad_pcb').read_bytes()
    assert abs(areas[lo]-areas[hi])>.05, 'BR03 '+lo+' context ignored'
print('BR03 collect/context probe PASS',areas)
