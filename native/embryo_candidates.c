/* Buffered candidates for the standard Flow box scan. The Flow scan retains
   the exact contact arithmetic. This module owns only cache storage/order. */
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
static double *anchors;
static int32_t *offsets, *ids, *ordered, *ends, *bins;
static int count, capacity, used, age, short_lives, cooldown;
static double skin;
static unsigned long builds, reuses, skips;
static int initialized, mode;
static void report(void) {
    if (getenv("EMBRYO_CANDIDATE_STATS"))
        fprintf(stderr,"Candidate cache: builds=%lu reuses=%lu bypasses=%lu\n",builds,reuses,skips);
}
void embryo_candidates_reset(void) {
    free(anchors); free(offsets); free(ids); free(ordered); free(ends); free(bins);
    anchors=NULL; offsets=NULL; ids=NULL; ordered=NULL; ends=NULL; bins=NULL;
    count=capacity=used=age=short_lives=cooldown=0;
}
static int append(int id) {
    if (used==capacity) {
        int next=capacity ? capacity*2 : 4096;
        if (capacity>=67108864) return 0;
        void *p=realloc(ids,(size_t)next*sizeof(*ids));
        if (!p) return 0;
        ids=p; capacity=next;
    }
    ids[used++]=id; return 1;
}
static int compare(const void *a,const void *b) {
    int i=*(const int32_t*)a,j=*(const int32_t*)b;
    for (int k=2;k>=0;k--) {
        int x=bins[i*3+k],y=bins[j*3+k];
        if (x!=y) return x<y ? -1 : 1;
    }
    return (j>i)-(j<i);
}
static inline int candidate_less(int32_t i, int32_t j) {
    for (int k = 2; k >= 0; k--) {
        int x = bins[i * 3 + k], y = bins[j * 3 + k];
        if (x != y) return x < y;
    }
    return i > j;
}
static inline void sort_candidates(int32_t *arr, int n) {
    if (n <= 1) return;
    if (n <= 32) {
        for (int i = 1; i < n; i++) {
            int32_t key = arr[i];
            int j = i - 1;
            while (j >= 0 && candidate_less(key, arr[j])) {
                arr[j + 1] = arr[j];
                j--;
            }
            arr[j + 1] = key;
        }
    } else {
        qsort(arr, (size_t)n, sizeof(int32_t), compare);
    }
}
int32_t *embryo_candidates_offsets(void) { return offsets; }
int32_t *embryo_candidates_ends(void) { return ends; }
int32_t *embryo_candidates_ids(void) { return ordered; }
int embryo_candidates_enabled(void) {
    if (!initialized) {
        const char *v=getenv("EMBRYO_CANDIDATES");
        mode=!v || strcmp(v,"0")!=0;
        initialized=1; atexit(report);
    }
    return mode;
}
int embryo_candidates_prepare(int n,const double *g,double scale,int side,
        const int32_t *heads,const int32_t *epochs,int epoch,const int32_t *next) {
    if (!embryo_candidates_enabled()) return 0;
    if (cooldown>0) { cooldown--; skips++; return 0; }
    int valid=count==n && count>0;
    double largest=0;
    for (int i=1;i<=n;i++) {
        const double *p=g+4*i;
        if (!isfinite(p[0])||!isfinite(p[1])||!isfinite(p[2])||!isfinite(p[3])||p[3]<0) {
            embryo_candidates_reset(); return 0;
        }
        if (p[3]>largest) largest=p[3];
        if (valid) {
            const double *a=anchors+4*i;
            double dx=p[0]-a[0],dy=p[1]-a[1],dz=p[2]-a[2];
            double growth=fmax(0,p[3]-a[3]);
            /* Each endpoint can consume at most half the buffer. */
            if (!(sqrt(dx*dx+dy*dy+dz*dz)+growth < skin*0.499999)) valid=0;
        }
    }
    if (!valid) {
        if (count && age<4) short_lives++; else short_lives=0;
        if (short_lives>=3) { cooldown=32; count=0; short_lives=0; skips++; return 0; }
        free(anchors); free(offsets); free(ends); free(bins); free(ordered);
        anchors=malloc((size_t)(n+1)*4*sizeof(double));
        offsets=malloc((size_t)(n+2)*sizeof(int32_t));
        ends=malloc((size_t)(n+1)*sizeof(int32_t));
        bins=malloc((size_t)(n+1)*3*sizeof(int32_t)); ordered=NULL;
        count=0; used=0;
        if (!anchors||!offsets||!ends||!bins) { embryo_candidates_reset(); return 0; }
        skin=0.4*largest;
        if (!(skin>0) || !isfinite(scale) || scale<=0) { embryo_candidates_reset(); return 0; }
        int half=side/2;
        for (int i=1;i<=n;i++) {
            const double *p=g+4*i;
            offsets[i]=used;
            int bx=(int)round(p[0]*scale),by=(int)round(p[1]*scale),bz=(int)round(p[2]*scale);
            int reach=(int)ceil((p[3]+largest+skin)*scale)+1;
            for(int z=bz-reach;z<=bz+reach;z++) for(int y=by-reach;y<=by+reach;y++) for(int x=bx-reach;x<=bx+reach;x++) {
                if(x < -half||x>half||y < -half||y>half||z < -half||z>half) continue;
                int64_t slot=((int64_t)(x+half)*side+y+half)*side+z+half;
                if(epochs[slot]!=epoch) continue;
                for(int j=heads[slot];j;j=next[j]) if(j!=i) {
                    const double *q=g+4*j;
                    double dx=q[0]-p[0],dy=q[1]-p[1],dz=q[2]-p[2];
                    double r=(p[3]+q[3]+skin)*1.000001;
                    if(dx*dx+dy*dy+dz*dz<=r*r && !append(j)) { embryo_candidates_reset(); return 0; }
                }
            }
        }
        offsets[n+1]=used;
        ordered=malloc((size_t)(used+1)*sizeof(int32_t));
        if(!ordered) { embryo_candidates_reset(); return 0; }
        memcpy(anchors,g,(size_t)(n+1)*4*sizeof(double));
        count=n; age=0; builds++;
    } else reuses++;
    age++;
    for(int i=1;i<=n;i++) for(int k=0;k<3;k++) bins[i*3+k]=(int)round(g[i*4+k]*scale);
    for(int i=1;i<=n;i++) {
        int end=offsets[i];
        for(int k=offsets[i];k<offsets[i+1];k++) {
            int j=ids[k];
            if(abs(bins[i*3]-bins[j*3])<=1 && abs(bins[i*3+1]-bins[j*3+1])<=1 && abs(bins[i*3+2]-bins[j*3+2])<=1)
                ordered[end++]=j;
        }
        ends[i]=end;
        sort_candidates(ordered+offsets[i], end-offsets[i]);
    }
    return 1;
}
