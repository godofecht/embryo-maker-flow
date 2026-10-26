#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Delaunay_triangulation_3.h>
#include <CGAL/Triangulation_cell_base_3.h>
#include <CGAL/Triangulation_data_structure_3.h>
#include <CGAL/Triangulation_vertex_base_with_info_3.h>

#include <algorithm>
#include <cstdint>
#include <set>
#include <memory>
#include <cmath>
#include <vector>

namespace {
using Kernel = CGAL::Exact_predicates_inexact_constructions_kernel;
using VertexBase = CGAL::Triangulation_vertex_base_with_info_3<std::int32_t, Kernel>;
using CellBase = CGAL::Triangulation_cell_base_3<Kernel>;
using Tds = CGAL::Triangulation_data_structure_3<VertexBase, CellBase>;
using Triangulation = CGAL::Delaunay_triangulation_3<Kernel, Tds>;
using Point = Kernel::Point_3;

struct DynamicTriangulation {
    Triangulation triangulation;
    std::vector<Triangulation::Vertex_handle> vertices;
    std::vector<double> coordinates;
    bool valid = true;
};

Point point_at(const double* xyz, std::int32_t id) {
    const auto offset = static_cast<std::size_t>(id) * 3;
    return Point(xyz[offset], xyz[offset + 1], xyz[offset + 2]);
}

bool same_point(const std::vector<double>& old, const double* xyz, std::int32_t id) {
    const auto offset = static_cast<std::size_t>(id) * 3;
    return old[offset] == xyz[offset] && old[offset + 1] == xyz[offset + 1] && old[offset + 2] == xyz[offset + 2];
}
}

extern "C" {
void* embryo_cgal_delaunay_create(const double* xyz, std::int32_t count) {
    if (!xyz || count < 4) return nullptr;
    for (std::int64_t i = 0; i < std::int64_t(count) * 3; ++i)
        if (!std::isfinite(xyz[i])) return nullptr;
    try {
    auto owned = std::make_unique<DynamicTriangulation>();
    auto* state = owned.get();
    state->vertices.resize(static_cast<std::size_t>(count));
    state->coordinates.assign(xyz, xyz + static_cast<std::size_t>(count) * 3);
    for (std::int32_t id = 0; id < count; ++id) {
        auto vertex = state->triangulation.insert(point_at(xyz, id));
        if (vertex == Triangulation::Vertex_handle()) { return nullptr; }
        vertex->info() = id + 1;
        state->vertices[static_cast<std::size_t>(id)] = vertex;
    }
    if (state->triangulation.number_of_vertices() != count) { return nullptr; }
    return owned.release();
    } catch (...) { return nullptr; }
}

int embryo_cgal_delaunay_move(void* opaque, const double* xyz, std::int32_t count) {
    if (!opaque || !xyz) return 0;
    auto* state = static_cast<DynamicTriangulation*>(opaque);
    if (!state->valid || count < 4 || static_cast<std::size_t>(count) != state->vertices.size()) return 0;
    for (std::int64_t i = 0; i < std::int64_t(count) * 3; ++i)
        if (!std::isfinite(xyz[i])) return 0;
    state->valid = false;
    try {
    for (std::int32_t id = 0; id < count; ++id) {
        auto& vertex = state->vertices[static_cast<std::size_t>(id)];
        if (!same_point(state->coordinates, xyz, id)) {
            auto moved = state->triangulation.move_if_no_collision(vertex, point_at(xyz, id));
            if (moved == Triangulation::Vertex_handle() || moved->info() != id + 1) return 0;
            vertex = moved;
        }
    }
    state->coordinates.assign(xyz, xyz + static_cast<std::size_t>(count) * 3);
    state->valid = true;
    return 1;
    } catch (...) { return 0; }
}

int embryo_cgal_delaunay_validate(void* opaque) {
    if (!opaque) return 0;
    auto* state = static_cast<DynamicTriangulation*>(opaque);
    try { return state->valid && state->triangulation.is_valid(false, 1) ? 1 : 0; }
    catch (...) { return 0; }
}

std::int32_t embryo_cgal_delaunay_edges(void* opaque, std::int32_t* output, std::int32_t capacity) {
    if (!opaque) return -1;
    auto* state = static_cast<DynamicTriangulation*>(opaque);
    if (!state->valid || capacity < 0) return -1;
    try {
    std::set<std::pair<std::int32_t, std::int32_t>> edges;
    for (auto edge = state->triangulation.finite_edges_begin(); edge != state->triangulation.finite_edges_end(); ++edge) {
        auto a = edge->first->vertex(edge->second)->info();
        auto b = edge->first->vertex(edge->third)->info();
        if (a > b) std::swap(a, b);
        edges.emplace(a, b);
    }
    const auto needed = static_cast<std::int32_t>(edges.size());
    if (!output || capacity < needed) return needed;
    std::int32_t index = 0;
    for (const auto& edge : edges) {
        output[index * 2] = edge.first;
        output[index * 2 + 1] = edge.second;
        ++index;
    }
    return needed;
    } catch (...) { return -1; }
}

void embryo_cgal_delaunay_destroy(void* opaque) {
    delete static_cast<DynamicTriangulation*>(opaque);
}
}
