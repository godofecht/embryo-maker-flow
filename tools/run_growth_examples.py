#!/usr/bin/env python3
"""Generate compact Arabidopsis seedling and Neurospora germling trajectories."""
from __future__ import annotations
import csv, gzip, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'ui/plant_models'
REPORT = ROOT / 'runs/growth_examples'

class Builder:
    def __init__(self): self.nodes=[]; self.cell=0
    def segment(self, a, b, kind, value=1.0, radius=.02, cell_id=None):
        if cell_id is None: self.cell += 1; cell_id=self.cell
        first=len(self.nodes)+1
        common={'radius':radius,'eqd':radius*.7,'type':kind,'cell':cell_id,'fixed':False,'lineage':cell_id,'genes':[value, float(kind)]}
        for ident, p, other in ((first,a,first+1),(first+1,b,first)):
            self.nodes.append({'id':ident,'x':p[0],'y':p[1],'z':p[2],'x0':p[0],'y0':p[1],'z0':p[2],'other':other,**common})
    def polyline(self, pts, kind, value=1., radius=.02):
        for a,b in zip(pts,pts[1:]): self.segment(a,b,kind,value,radius)
    def cell_wireframe(self, edges, kind, value, radius=.02):
        self.cell += 1; cell_id=self.cell
        for a,b in edges: self.segment(a,b,kind,value,radius,cell_id)
    def hex_cell(self, center, size, kind, value):
        x,y,z=center
        verts=[(x+size*math.cos(math.pi*k/3),y+size*math.sin(math.pi*k/3),z) for k in range(6)]
        self.cell_wireframe(list(zip(verts,verts[1:]+verts[:1])),kind,value,size*.12)
    def cross_cell(self, center, size, kind, value):
        x,y,z=center
        edges=[((x-size,y-size,z),(x+size,y+size,z)),((x-size,y+size,z),(x+size,y-size,z))]
        self.cell_wireframe(edges,kind,value,size*.13)
    def leaf(self, base, angle, length, width, kind=4):
        # Flat blade: tapered centerline, paired margins, midrib, and two vein pairs.
        ux,uy=math.cos(angle),math.sin(angle); vx,vy=-uy,ux
        def p(t,s=0): return (base[0]+ux*length*t+vx*width*s*math.sin(math.pi*t), base[1]+uy*length*t+vy*width*s*math.sin(math.pi*t),base[2])
        self.polyline([p(i/8) for i in range(9)],kind,.8,.035)
        for sign in (-1,1): self.polyline([p(i/8,sign) for i in range(9)],kind,.7,.025)
        for t in (.35,.58,.78):
            self.segment(p(t),p(t+.12,.7),kind,.65,.014); self.segment(p(t),p(t+.12,-.7),kind,.65,.014)

def plant_frame(hours):
    b=Builder(); days=hours/24
    # Root growth through day 5 is an explicit interpolation; days 5 to 10 use
    # 10.8 mm/day reported for Col-0 under the cited plate conditions.
    root_mm=28*min(days/5,1) if days<=5 else 28+10.8*(days-5)
    root_v=root_mm*.045; stem_v=min(days/7,1)*.34
    b.polyline([(0,.05,0),(0,-root_v,0)],1,.2,.035)
    # Primordia spacing uses observed mean 1.6 mm. Emergent laterals are a
    # visual developmental approximation with age-dependent downward curvature.
    n=min(26,int(root_mm/1.6))
    for i in range(n):
        d=(i+.5)*root_mm/max(n,1); y=-d*.045
        age=max(0,days-(2.0+d/10.8))
        if age < .12: # small primordium
            end=(.035,y-.012,0)
            b.segment((0,y,0),end,2,.2,.012)
        else:
            length=min(.24,.045+age*.035)
            theta=math.radians(88- min(35,age*10))
            pts=[(length*j/5*math.cos(theta),y-length*j/5*math.sin(theta),0) for j in range(6)]
            b.polyline(pts,2,.35,.016)
    # Hypocotyl and shoot axis
    b.polyline([(0,0,0),(0,stem_v*.48,0),(0,stem_v,0)],3,.55,.04)
    # Opposite cotyledons, expanding during the first week.
    cot=min(1,max(0,(days-.5)/2.5)); base=(0,stem_v*.85,0)
    if cot:
        for angle in (math.radians(28),math.radians(208)):
            b.leaf(base,angle,.08+.25*cot,.055+.075*cot,4)
    # First true leaves follow a ~137 degree divergence and ~24h plastochron.
    true_count=max(0,min(4,int(max(0,days-6))))
    for j in range(true_count):
        emergence=6+j
        if days < emergence: continue
        fraction=min(1,(days-emergence+.15)/1.5)
        angle=math.radians(137*j+18)
        length=(.055+.19*fraction)*min(1,days/7)
        b.leaf((0,stem_v,0),angle,length,length*.48,5)
    return b.nodes, {'time_hours':hours,'days_after_germination':days,'primary_root_length_mm_model':root_mm,'lateral_root_count_rendered':n,'true_leaf_count_rendered':true_count}

def fungus_frame(minutes):
    b=Builder(); h=minutes/60
    # Image scale is 0.055 scene units per mm. Germling growth uses published
    # cap/collar values; mature leading growth uses 3 mm/h colony-front rate.
    b.segment((-.045,0,0),(.045,0,0),1,.2,.045) # conidium
    if h>1:
        germ_um=min(1400,max(0,(h-1)*60*1.75))
        germ_mm=germ_um/1000
        mature_mm=max(0,h-1-1400/(60*1.75))*3
        length=(germ_mm+mature_mm)*.055
        tip=(length,.0,0)
        b.polyline([(.035,0,0),(length*.25,.008,0),(length*.62,-.003,0),tip],2,.45,.018)
        # Branches are initiated after the reported ~10 h subapical-branch stage.
        if h>=10:
            for frac,sign in ((.42,1),(.67,-1),(.83,1)):
                bx=length*frac; by=0
                branch_mm=min(max(0,(h-10)*.012),1.0)
                end=(bx+branch_mm*.055*.72,by+sign*branch_mm*.055*.7,0)
                b.polyline([(bx,by,0),((bx+end[0])/2,by+sign*branch_mm*.055*.32,0),end],3,.7,.014)
    return b.nodes, {'time_minutes':minutes,'time_hours':h,'hyphal_tip_count_rendered':1+(0 if h<10 else min(3,int((h-10)/1.5)+1))}

def cancer_spheroid_frame(diameter_um):
    b=Builder(); radius=diameter_um/2; scale=.008; spacing=20.; cell_size=8.*scale
    hypoxia_onset=max(0.,min(1.,(diameter_um-500.)/50.))
    necrosis_progress=max(0.,min(1.,(diameter_um-550.)/150.))
    necrotic_radius=radius*(necrosis_progress*.82)
    points=[]; row=0; y=-radius
    while y<=radius:
        x=-radius+(row%2)*spacing/2
        while x<=radius:
            if math.hypot(x,y)<=radius:
                depth=radius-math.hypot(x,y)
                if math.hypot(x,y)<necrotic_radius: kind,value=8,.05
                elif hypoxia_onset>0 and depth>100.*(1-hypoxia_onset): kind,value=7,.4
                else: kind,value=6,.95
                b.cross_cell((x*scale,y*scale,0),cell_size,kind,value)
                points.append((kind,x,y))
            x+=spacing
        row+=1; y+=spacing*math.sqrt(3)/2
    return b.nodes,{'spheroid_diameter_um':diameter_um,'cross_section_cells':len(points),
                    'proliferative_cells':sum(k==6 for k,x,y in points),
                    'hypoxic_cells':sum(k==7 for k,x,y in points),
                    'necrotic_cells':sum(k==8 for k,x,y in points),
                    'modeled_necrotic_volume_fraction':necrosis_progress*.55}

def elegans_frame(minutes):
    b=Builder()
    if minutes<40: cells=[('P0',(0,0,0),.34,1,.5)]
    elif minutes<56: cells=[('AB',(-.30,0,0),.26,2,1.),('P1',(.30,0,0),.21,3,.45)]
    elif minutes<58: cells=[('ABa',(-.45,0,0),.19,2,1.),('ABp',(-.12,0,0),.19,2,.85),('P1',(.32,0,0),.16,3,.45)]
    elif minutes<74: cells=[('ABa',(-.43,0,0),.17,2,1.),('ABp',(-.10,.05,0),.17,2,.85),('EMS',(.20,-.16,0),.15,4,.7),('P2',(.42,.14,0),.13,3,.4)]
    elif minutes<80: cells=[('ABal',(-.56,-.12,-.08),.13,2,1.),('ABar',(-.42,.12,.08),.13,2,1.),('ABpl',(-.16,-.16,.08),.13,2,.85),('ABpr',(-.11,.17,-.08),.13,2,.85),('EMS',(.20,-.15,0),.13,4,.7),('P2',(.43,.14,0),.12,3,.4)]
    else: cells=[('ABal',(-.57,-.12,-.08),.12,2,1.),('ABar',(-.43,.12,.08),.12,2,1.),('ABpl',(-.17,-.16,.08),.12,2,.85),('ABpr',(-.12,.17,-.08),.12,2,.85),('MS',(.17,-.20,0),.12,4,.7),('E',(.05,-.34,0),.12,5,.95),('C',(.43,.24,0),.12,6,.65),('P3',(.56,.04,0),.09,3,.3)]
    shell=[(.88*math.cos(2*math.pi*i/48),.48*math.sin(2*math.pi*i/48),0) for i in range(49)]
    b.polyline(shell,1,.1,.009)
    for name,(x,y,z),radius,kind,fate in cells:
        verts=[(x+radius,y,z),(x-radius,y,z),(x,y+radius,z),(x,y-radius,z),(x,y,z+radius),(x,y,z-radius)]
        edges=[(verts[i],verts[j]) for i in range(6) for j in range(i+1,6) if i//2!=j//2]
        b.cell_wireframe(edges,kind,fate,.012)
    return b.nodes,{'time_minutes_after_fertilization':minutes,'blastomere_count':len(cells),'lineages':' '.join(c[0] for c in cells)}

def write_project(name, experiment, times, make):
    frames=[]; rows=[]
    for t in times:
        nodes,metrics=make(t); rows.append(metrics)
        frames.append({'iterations':t,'simulatedTime':t,'experiment':experiment,'count':len(nodes),'geneCount':2,'nodes':nodes,'cells':[],'edges':[],'triangulationWarning':0})
    end=times[-1]
    project={'format':'embryomaker-trajectory','version':1,'name':name,'experiment':experiment,'totalIterations':end,'minIteration':times[0],'maxIteration':end,'frameCount':len(frames),'camera':{'yaw':0.,'pitch':0.,'zoom':1.,'panX':0.,'panY':0.,'cameraDistance':8.},'display':{'colorMode':'type','paletteMode':'multi','pointScale':1.,'radiusMode':'add','showNodes':True,'showCylinders':True},'iterations':times,'frames':frames}
    project['timelineLabel']={'arabidopsis_seedling':'Hours after germination','neurospora_crassa':'Minutes after inoculation','a673_cancer_spheroid':'Diameter (um)','c_elegans_embryo':'Minutes after fertilization'}.get(experiment,'Iteration')
    path=OUT/(experiment+'.json.gz')
    with path.open('wb') as f:
        with gzip.GzipFile(fileobj=f,mode='wb',mtime=0) as gz: gz.write(json.dumps(project,separators=(',',':')).encode())
    return path,rows

def main():
    OUT.mkdir(parents=True,exist_ok=True); REPORT.mkdir(parents=True,exist_ok=True)
    plant,pr=write_project('Arabidopsis thaliana Col-0 seedling','arabidopsis_seedling',list(range(0,241,6)),plant_frame)
    fungus,fr=write_project('Neurospora crassa conidium to mycelium','neurospora_crassa',list(range(0,961,30)),fungus_frame)
    cancer,cr=write_project('A673 human cancer spheroid cross-section','a673_cancer_spheroid',list(range(200,701,25)),cancer_spheroid_frame)
    worm,wr=write_project('Caenorhabditis elegans early embryo lineage','c_elegans_embryo',list(range(0,91,2)),elegans_frame)
    # Check the published calibration points and developmental transitions.
    assert abs(pr[20]['primary_root_length_mm_model'] - 28.0) < 1e-9
    assert abs(pr[-1]['primary_root_length_mm_model'] - 82.0) < 1e-9
    assert pr[0]['true_leaf_count_rendered'] == 0 and pr[-1]['true_leaf_count_rendered'] == 4
    assert fr[0]['hyphal_tip_count_rendered'] == 1
    assert fr[20]['time_hours'] == 10 and fr[20]['hyphal_tip_count_rendered'] >= 2
    assert fr[-1]['hyphal_tip_count_rendered'] >= 3
    assert cr[0]['necrotic_cells']==0 and cr[-1]['modeled_necrotic_volume_fraction'] > .54
    assert [wr[i]['blastomere_count'] for i in (0,20,29,40)] == [1,2,4,8]
    for fn,rows in [('arabidopsis_seedling_metrics.csv',pr),('neurospora_crassa_metrics.csv',fr),('a673_cancer_spheroid_metrics.csv',cr),('c_elegans_embryo_metrics.csv',wr)]:
        with (REPORT/fn).open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0]),lineterminator='\n');w.writeheader();w.writerows(rows)
    (REPORT/'README.md').write_text('''# Growth examples\n\n## Arabidopsis thaliana Col-0 seedling\n\nThe 10-day trajectory shows the primary root, lateral root primordia and emerging laterals, hypocotyl, opposite cotyledons, and successive true leaves. The mean lateral-primordium spacing (1.6 mm) and day 5 to 10 primary-root extension (10.8 mm/day) come from published Col-0 plate measurements. Root length through day 5, lateral-root emergence timing and bending, cotyledon dimensions, and visible leaf dimensions are model assumptions. True leaves use a 24-hour plastochron and 137-degree divergence as approximate long-day pattern values. This model represents organ-scale development. Cell-level mechanics remain outside its scope.\n\n## Neurospora crassa\n\nThe 16-hour trajectory shows conidial swelling, a germ tube, a leading hypha, and subapical branches. Germ tube polarization around 3 hours, a primary hypha by 5 hours, and branches by 10 hours follow published observations. Germling elongation uses a reported collar-stage rate; mature extension uses the reported 3 mm/hour colony growth rate as a simplified tip-growth approximation. Branch placement and branch geometry are illustrative.\n\n## A673 human cancer spheroid\n\nThe trajectory shows a growing equatorial cross-section. A673 spheroids show hypoxia staining above 500 micrometres in diameter and visible central necrosis around 550 to 650 micrometres. Near maximum size, reported necrosis occupies 50 to 60 percent of spheroid volume. The model uses a 100 micrometre proliferative rim as a geometry assumption and ramps the necrotic core from zero at 550 micrometres to 55 percent of volume at 700 micrometres. Intermediate shapes and cell states are a compact reconstruction of those observations.\n\n## C. elegans early embryo\n\nThis 90-minute trajectory shows the invariant lineage from the zygote through the 8-cell stage at 20 C. It displays the unequal P0 cleavage, AB and P1, ABa and ABp, EMS and P2, then ABal, ABar, ABpl, ABpr, MS, E, C, and P3. Cell division timings are approximate reconstructions of the published lineage. Cell positions and the eggshell outline are schematic. Cell fate colors encode lineage class. They are illustrative.\n\nRebuild with `python3 tools/run_growth_examples.py`. The compressed viewer trajectories are under `ui/plant_models/`. Per-frame values are in the CSV files here.\n\nReferences:\n- [Priming and positioning of lateral roots in Arabidopsis](https://pmc.ncbi.nlm.nih.gov/articles/PMC4762386/)\n- [Phyllotactic regularity requires the Paf1 complex in Arabidopsis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5769633/)\n- [CLAVATA3 Signaling Buffers Arabidopsis Shoot Apical Meristem Activity](https://pmc.ncbi.nlm.nih.gov/articles/PMC11394970/)\n- [The Genetic Basis of Cellular Morphogenesis in Neurospora crassa](https://pmc.ncbi.nlm.nih.gov/articles/PMC266756/)\n- [Dissecting Colony Development of Neurospora crassa](https://pmc.ncbi.nlm.nih.gov/articles/PMC2547062/)\n- [From Cap to Collar: Ontogeny of the Endocytic Collar](https://pmc.ncbi.nlm.nih.gov/articles/PMC12387980/)\n- [Linking hypoxia, DNA damage and proliferation in multicellular tumor spheroids](https://pmc.ncbi.nlm.nih.gov/articles/PMC5437385/)\n- [The embryonic cell lineage of the nematode Caenorhabditis elegans](https://pubmed.ncbi.nlm.nih.gov/6684600/)\n''')
    print(f'{plant}: {plant.stat().st_size} bytes, {len(pr)} frames')
    print(f'{fungus}: {fungus.stat().st_size} bytes, {len(fr)} frames')
    print(f'{cancer}: {cancer.stat().st_size} bytes, {len(cr)} frames; modeled necrotic volume fraction reaches {cr[-1]["modeled_necrotic_volume_fraction"]:.2f}')
    print(f'{worm}: {worm.stat().st_size} bytes, {len(wr)} frames; blastomeres progress from {wr[0]["blastomere_count"]} to {wr[-1]["blastomere_count"]}')
if __name__=='__main__': main()
