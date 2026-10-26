/* Isolated fixed-radius neighbor-search benchmark. No simulation integration.
 * Constant density, identical trajectories, exact graph checks each frame.
 * Build: cc -O3 -std=c11 -ffp-contract=off tools/neighbor_reuse_bench.c -lm -o bench
 */
#define _POSIX_C_SOURCE 200809L
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { double x, y, z; } Point;
typedef struct { int a, b; double d2; } Edge;
typedef struct { Edge *data; size_t size, capacity; } Edges;
typedef struct {
    int *head, *next;
    size_t capacity;
    int nx, ny, nz;
    Point origin;
    double width;
} Grid;
typedef struct {
    Grid grid;
    Edges candidates;
    Point *anchors;
    int ready, rebuilds;
    uint64_t distance_checks;
} Cache;

static void die(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static void *allocate(size_t bytes) {
    void *p = malloc(bytes);
    if (!p) die("allocation failed");
    return p;
}
static double now(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) die("clock failed");
    return t.tv_sec + t.tv_nsec * 1e-9;
}
static double box_length;
static double squared(Point a, Point b) {
    double x = a.x - b.x, y = a.y - b.y, z = a.z - b.z;
    if (box_length > 0) {
        double half = 0.5 * box_length;
        if (x > half) x -= box_length; else if (x < -half) x += box_length;
        if (y > half) y -= box_length; else if (y < -half) y += box_length;
        if (z > half) z -= box_length; else if (z < -half) z += box_length;
    }
    return (x*x + y*y) + z*z;
}
static void append(Edges *edges, int a, int b, double d2) {
    if (edges->size == edges->capacity) {
        size_t capacity = edges->capacity ? 2 * edges->capacity : 256;
        void *p = realloc(edges->data, capacity * sizeof(Edge));
        if (!p) die("edge allocation failed");
        edges->data = p;
        edges->capacity = capacity;
    }
    edges->data[edges->size++] = (Edge){a, b, d2};
}
static int compare_edge(const void *a, const void *b) {
    const Edge *x = a, *y = b;
    if (x->a != y->a) return (x->a > y->a) - (x->a < y->a);
    return (x->b > y->b) - (x->b < y->b);
}
static void verify(Edges *a, Edges *b) {
    if (a->size > 1) qsort(a->data, a->size, sizeof(Edge), compare_edge);
    if (b->size > 1) qsort(b->data, b->size, sizeof(Edge), compare_edge);
    if (a->size != b->size) die("edge count mismatch");
    for (size_t i = 0; i < a->size; i++) {
        if (a->data[i].a != b->data[i].a || a->data[i].b != b->data[i].b ||
            memcmp(&a->data[i].d2, &b->data[i].d2, sizeof(double)))
            die("edge identity or squared-distance mismatch");
    }
}
static int coordinate(double value, double origin, double width) {
    return (int)floor((value - origin) / width);
}
static int index_at(Grid *g, int x, int y, int z) {
    return (z * g->ny + y) * g->nx + x;
}
static void rebuild_grid(Grid *g, const Point *p, int n, double width) {
    Point lo = p[0], hi = p[0];
    for (int i = 1; i < n; i++) {
        lo.x = fmin(lo.x, p[i].x); lo.y = fmin(lo.y, p[i].y); lo.z = fmin(lo.z, p[i].z);
        hi.x = fmax(hi.x, p[i].x); hi.y = fmax(hi.y, p[i].y); hi.z = fmax(hi.z, p[i].z);
    }
    g->origin = lo;
    g->width = width;
    g->nx = coordinate(hi.x, lo.x, width) + 1;
    g->ny = coordinate(hi.y, lo.y, width) + 1;
    g->nz = coordinate(hi.z, lo.z, width) + 1;
    if (box_length > 0) {
        g->nx = g->ny = g->nz = (int)floor(box_length / width);
        if (g->nx < 1) g->nx = g->ny = g->nz = 1;
        g->origin = lo = (Point){0,0,0};
        g->width = width = box_length / g->nx;
    }
    size_t cells = (size_t)g->nx * g->ny * g->nz;
    if (cells > g->capacity) {
        void *data = realloc(g->head, cells * sizeof(int));
        if (!data) die("grid allocation failed");
        g->head = data; g->capacity = cells;
    }
    for (size_t i = 0; i < cells; i++) g->head[i] = -1;
    for (int i = 0; i < n; i++) {
        int x = coordinate(p[i].x, lo.x, width), y = coordinate(p[i].y, lo.y, width), z = coordinate(p[i].z, lo.z, width);
        int cell = index_at(g, x, y, z);
        g->next[i] = g->head[cell]; g->head[cell] = i;
    }
}
static void grid_edges(Grid *g, const Point *p, int n, double radius, Edges *out, uint64_t *checks) {
    rebuild_grid(g, p, n, radius);
    out->size = 0;
    for (int i = 0; i < n; i++) {
        int cx = coordinate(p[i].x, g->origin.x, g->width);
        int cy = coordinate(p[i].y, g->origin.y, g->width);
        int cz = coordinate(p[i].z, g->origin.z, g->width);
        for (int z = cz-1; z <= cz+1; z++) {
            if (box_length > 0 && ((g->nz == 2 && z == cz+1) || (g->nz == 1 && z != cz))) continue;
            int bz = box_length > 0 ? (z+g->nz)%g->nz : z;
            if (bz < 0 || bz >= g->nz) continue;
            for (int y = cy-1; y <= cy+1; y++) {
                if (box_length > 0 && ((g->ny == 2 && y == cy+1) || (g->ny == 1 && y != cy))) continue;
                int by = box_length > 0 ? (y+g->ny)%g->ny : y;
                if (by < 0 || by >= g->ny) continue;
                for (int x = cx-1; x <= cx+1; x++) {
                    if (box_length > 0 && ((g->nx == 2 && x == cx+1) || (g->nx == 1 && x != cx))) continue;
                    int bx = box_length > 0 ? (x+g->nx)%g->nx : x;
                    if (bx < 0 || bx >= g->nx) continue;
                    for (int j = g->head[index_at(g,bx,by,bz)]; j != -1; j = g->next[j]) {
                        if (j <= i) continue;
                        ++*checks;
                        double d2 = squared(p[i], p[j]);
                        if (d2 <= radius * radius) append(out, i, j, d2);
                    }
                }
            }
        }
    }
}
static void cached_edges(Cache *c, const Point *p, int n, double cutoff, double skin, Edges *out) {
    int rebuild = !c->ready;
    double threshold = skin * 0.5 * (1.0 - 32 * DBL_EPSILON);
    for (int i = 0; !rebuild && i < n; i++)
        if (squared(p[i], c->anchors[i]) >= threshold * threshold) rebuild = 1;
    if (rebuild) {
        grid_edges(&c->grid, p, n, nextafter(cutoff + skin, INFINITY), &c->candidates, &c->distance_checks);
        memcpy(c->anchors, p, (size_t)n * sizeof(Point));
        c->ready = 1; c->rebuilds++;
    }
    out->size = 0;
    for (size_t i = 0; i < c->candidates.size; i++) {
        Edge pair = c->candidates.data[i];
        c->distance_checks++;
        double d2 = squared(p[pair.a], p[pair.b]);
        if (d2 <= cutoff * cutoff) append(out, pair.a, pair.b, d2);
    }
}
static void oracle(const Point *p, int n, double cutoff, Edges *out) {
    out->size = 0;
    for (int i = 0; i < n; i++) for (int j = i+1; j < n; j++) {
        double d2 = squared(p[i],p[j]);
        if (d2 <= cutoff * cutoff) append(out,i,j,d2);
    }
}
static uint64_t random_state;
static double uniform(void) {
    random_state += UINT64_C(0x9e3779b97f4a7c15);
    uint64_t z = random_state;
    z = (z ^ (z >> 30)) * UINT64_C(0xbf58476d1ce4e5b9);
    z = (z ^ (z >> 27)) * UINT64_C(0x94d049bb133111eb);
    return ((z ^ (z >> 31)) >> 11) * 0x1.0p-53;
}
static void release_grid(Grid *g) { free(g->head); free(g->next); }
static void boundary_check(void) {
    Point p[2] = {{0,0,0}, {1.4500001,0,0}};
    Cache c = {.grid.next = allocate(2*sizeof(int)), .anchors=allocate(2*sizeof(Point))};
    Edges got = {0}, expected = {0};
    cached_edges(&c,p,2,1.15,0.3,&got); oracle(p,2,1.15,&expected); verify(&got,&expected);
    p[0].x += 0.150001; p[1].x -= 0.150001;
    cached_edges(&c,p,2,1.15,0.3,&got); oracle(p,2,1.15,&expected); verify(&got,&expected);
    if (c.rebuilds != 2 || got.size != 1) die("two moving endpoints were not rebuilt safely");
    box_length = 4; c.ready = 0; c.rebuilds = 0;
    p[0] = (Point){0.05,0,0}; p[1] = (Point){3.95,0,0};
    cached_edges(&c,p,2,1.15,0.3,&got); oracle(p,2,1.15,&expected); verify(&got,&expected);
    p[0].x = 3.99; p[1].x = 0.01;
    cached_edges(&c,p,2,1.15,0.3,&got); oracle(p,2,1.15,&expected); verify(&got,&expected);
    if (c.rebuilds != 1 || got.size != 1) die("periodic boundary reuse failed");
    box_length = 0;
    free(c.anchors); free(c.candidates.data); release_grid(&c.grid); free(got.data); free(expected.data);
}
static void run(int side, int steps, int repeat, double motion) {
    int n = side*side*side;
    box_length = side;
    Point *trajectory = allocate((size_t)steps*n*sizeof(Point));
    random_state = 1234567;
    for (int z=0, i=0; z<side; z++) for (int y=0; y<side; y++) for (int x=0; x<side; x++,i++)
        trajectory[i] = (Point){x+0.16*(uniform()-0.5), y+0.16*(uniform()-0.5), z+0.16*(uniform()-0.5)};
    for (int step=1; step<steps; step++) for (int i=0; i<n; i++) {
        Point prev = trajectory[(size_t)(step-1)*n+i];
        trajectory[(size_t)step*n+i] = (Point){prev.x+motion*(2*uniform()-1),prev.y+motion*(2*uniform()-1),prev.z+motion*(2*uniform()-1)};
    }
    /* Periodic boundaries preserve density exactly as the cells move. */
    for (size_t i=0; i<(size_t)steps*n; i++) {
        trajectory[i].x -= side * floor(trajectory[i].x / side);
        trajectory[i].y -= side * floor(trajectory[i].y / side);
        trajectory[i].z -= side * floor(trajectory[i].z / side);
    }
    Grid g = {.next=allocate((size_t)n*sizeof(int))};
    Cache c = {.grid.next=allocate((size_t)n*sizeof(int)), .anchors=allocate((size_t)n*sizeof(Point))};
    Edges reference={0}, reused={0}, all_pairs={0};
    uint64_t checks=0, edge_total=0;
    double reference_time=0, reused_time=0;
    for (int step=0; step<steps; step++) {
        const Point *p=trajectory+(size_t)step*n;
        /* Alternate execution order to reduce consistent cache-order bias. */
        for (int pass=0; pass<2; pass++) {
            double start=now();
            if ((step+repeat+pass)%2 == 0) {
                grid_edges(&g,p,n,1.15,&reference,&checks); reference_time+=now()-start;
            } else {
                cached_edges(&c,p,n,1.15,0.3,&reused); reused_time+=now()-start;
            }
        }
        verify(&reference,&reused); /* Sorting and validation are outside timing. */
        if (n<=216) { oracle(p,n,1.15,&all_pairs); verify(&reference,&all_pairs); }
        edge_total+=reference.size;
    }
    printf("%d,%d,%d,%.3f,%.9f,%.9f,%d,%llu,%llu,%.3f\n",n,steps,repeat,motion,
        reference_time,reused_time,c.rebuilds,(unsigned long long)checks,
        (unsigned long long)c.distance_checks,(double)edge_total/steps);
    fflush(stdout);
    free(trajectory); free(c.anchors); free(c.candidates.data);
    free(reference.data); free(reused.data); free(all_pairs.data); release_grid(&g); release_grid(&c.grid);
}
int main(void) {
    boundary_check();
    puts("cells,steps,repeat,motion,grid_seconds,reuse_seconds,rebuilds,grid_checks,reuse_checks,mean_edges");
    int sizes[]={4,6,8,10,12,16};
    double motions[]={0.01,0.08,0.20};
    for (int mode=0; mode<3; mode++) for (size_t i=0; i<sizeof(sizes)/sizeof(*sizes); i++)
        for (int repeat=0; repeat<5; repeat++) run(sizes[i],300,repeat,motions[mode]);
    return 0;
}
