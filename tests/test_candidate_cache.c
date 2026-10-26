/* Exercise the production cache against an independent ordered box scan. */
#include "../native/embryo_candidates.c"
#include <assert.h>
static uint32_t seed=73;
static double random_unit(void) { seed=1664525*seed+1013904223; return (seed>>8)/16777216.0; }
int main(void) {
    enum { N=64, SIDE=25, BOXES=SIDE*SIDE*SIDE };
    double g[(N+1)*4]={0};
    int32_t heads[BOXES],epochs[BOXES],next[N+1];
    setenv("EMBRYO_CANDIDATES","1",1);
    for(int i=1;i<=N;i++) { for(int k=0;k<3;k++) g[4*i+k]=(random_unit()-.5)*5; g[4*i+3]=.4; }
    for(int frame=0;frame<400;frame++) {
        int n=frame>=200 && frame<250 ? N-1 : N;
        double radius=0;
        for(int i=1;i<=n;i++) {
            for(int k=0;k<3;k++) g[4*i+k]+=(random_unit()-.5)*(frame<300 ? .002 : .2);
            if(frame==100) g[4*i+3]=.6;
            if(g[4*i+3]>radius) radius=g[4*i+3];
        }
        double scale=1/(2*radius+.001);
        memset(heads,0,sizeof(heads));
        for(int i=0;i<BOXES;i++) epochs[i]=1;
        for(int i=1;i<=n;i++) {
            int x=(int)round(g[4*i]*scale)+SIDE/2,y=(int)round(g[4*i+1]*scale)+SIDE/2,z=(int)round(g[4*i+2]*scale)+SIDE/2;
            assert(x>0&&x<SIDE-1&&y>0&&y<SIDE-1&&z>0&&z<SIDE-1);
            int slot=(x*SIDE+y)*SIDE+z;next[i]=heads[slot];heads[slot]=i;
        }
        if(!embryo_candidates_prepare(n,g,scale,SIDE,heads,epochs,1,next)) continue;
        for(int i=1;i<=n;i++) {
            int expected[N],actual[N],ne=0,na=0;
            int bx=(int)round(g[4*i]*scale)+SIDE/2,by=(int)round(g[4*i+1]*scale)+SIDE/2,bz=(int)round(g[4*i+2]*scale)+SIDE/2;
            for(int z=bz-1;z<=bz+1;z++) for(int y=by-1;y<=by+1;y++) for(int x=bx-1;x<=bx+1;x++)
                for(int j=heads[(x*SIDE+y)*SIDE+z];j;j=next[j]) if(i!=j) {
                    double dx=g[4*j]-g[4*i],dy=g[4*j+1]-g[4*i+1],dz=g[4*j+2]-g[4*i+2],r=g[4*j+3]+g[4*i+3];
                    if((dx*dx+dy*dy)+dz*dz<=r*r) expected[ne++]=j;
                }
            for(int k=offsets[i];k<ends[i];k++) {
                int j=ordered[k];
                double dx=g[4*j]-g[4*i],dy=g[4*j+1]-g[4*i+1],dz=g[4*j+2]-g[4*i+2],r=g[4*j+3]+g[4*i+3];
                if((dx*dx+dy*dy)+dz*dz<=r*r) actual[na++]=j;
            }
            assert(ne==na); assert(memcmp(expected,actual,(size_t)ne*sizeof(int))==0);
        }
    }
    assert(builds>3 && reuses>100 && skips>0);
    embryo_candidates_reset();
    assert(count==0 && anchors==NULL);
    puts("PASS: ordered contacts, radius growth, node count changes, movement, cooldown, reset");
}
