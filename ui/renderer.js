(() => {
  const OG_RENDER_STAGE_ORDER = Object.freeze([
    'common-lines',
    'eggshell',
    'epithelial-springs',
    'box-grid',
    'node-loop',
    'connections',
    'slice-plots',
    'cell-centroids'
  ]);
  const canvas = document.getElementById('stageGL');
  // The OG drawer writes an opaque black framebuffer. Keep the browser
  // drawing buffer opaque too, or the compositor applies its output alpha a
  // second time after WebGL has already blended transparent spheres.
  const gl = canvas?.getContext('webgl', { alpha: false, antialias: false, depth: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  if (!gl) {
    window.embryomakerRenderer = { active: false, render: () => {} };
    return;
  }

  const vertexSource = `
    attribute vec3 position;
    attribute vec3 normal;
    attribute vec3 color;
    attribute float vertexAlpha;
    attribute vec3 instanceCenter;
    attribute float instanceRadius;
    attribute vec3 instanceAxis;
    attribute float instanceElongation;
    attribute float instanceAlpha;
    uniform mat4 projection;
    uniform mat4 modelView;
    uniform mat3 normalMatrix;
    uniform vec3 lightDirection;
    uniform float instanced;
    uniform float sphereNormalScale;
    uniform float drawAlpha;
    uniform float vertexAlphaEnabled;
    varying vec3 surfaceColor;
    varying vec3 surfaceLighting;
    varying float surfaceAlpha;
    vec3 rotateFromX(vec3 value, vec3 axis) {
      float cosine = clamp(axis.x, -1.0, 1.0);
      vec3 turnAxis = vec3(0.0, -axis.z, axis.y);
      float sine = length(turnAxis);
      if (sine < 0.000001) return cosine >= 0.0 ? value : vec3(-value.x, value.y, -value.z);
      turnAxis /= sine;
      return value * cosine + cross(turnAxis, value) * sine + turnAxis * dot(turnAxis, value) * (1.0 - cosine);
    }
    void main() {
      vec3 axis = normalize(instanceAxis);
      float elongation = mix(1.0, instanceElongation, instanced);
      vec3 ellipsoidPosition = rotateFromX(vec3(position.x * elongation, position.y / elongation, position.z / elongation), axis);
      vec3 ellipsoidNormal = rotateFromX(vec3(normal.x / elongation, normal.y * elongation, normal.z * elongation), axis);
      // OG scales sphere coordinates before the model-view transform.
      vec3 transformedNormal = normalMatrix * mix(normal, ellipsoidNormal, instanced) * mix(1.0, sphereNormalScale, instanced);
      float diffuse = max(dot(transformedNormal, normalize(lightDirection)), 0.0);
      surfaceLighting = vec3(clamp(0.5 + diffuse, 0.0, 1.0));
      vec3 localPosition = mix(position, ellipsoidPosition, instanced) * mix(1.0, instanceRadius, instanced) + instanceCenter * instanced;
      gl_Position = projection * modelView * vec4(localPosition, 1.0);
      surfaceColor = color;
      surfaceAlpha = mix(drawAlpha, instanceAlpha, instanced);
      surfaceAlpha = mix(surfaceAlpha, vertexAlpha, vertexAlphaEnabled * (1.0 - instanced));
    }
  `;
  const fragmentSource = `
    precision mediump float;
    varying vec3 surfaceColor;
    varying vec3 surfaceLighting;
    varying float surfaceAlpha;
    void main() {
      gl_FragColor = vec4(surfaceColor * surfaceLighting, surfaceAlpha);
    }
  `;
  function shader(type, source) {
    const value = gl.createShader(type);
    gl.shaderSource(value, source);
    gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value));
    return value;
  }
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const attributes = {
    position: gl.getAttribLocation(program, 'position'),
    normal: gl.getAttribLocation(program, 'normal'),
    color: gl.getAttribLocation(program, 'color'),
    vertexAlpha: gl.getAttribLocation(program, 'vertexAlpha'),
    instanceCenter: gl.getAttribLocation(program, 'instanceCenter'),
    instanceRadius: gl.getAttribLocation(program, 'instanceRadius'),
    instanceAxis: gl.getAttribLocation(program, 'instanceAxis'),
    instanceElongation: gl.getAttribLocation(program, 'instanceElongation'),
    instanceAlpha: gl.getAttribLocation(program, 'instanceAlpha')
  };
  const uniforms = {
    projection: gl.getUniformLocation(program, 'projection'),
    modelView: gl.getUniformLocation(program, 'modelView'),
    normalMatrix: gl.getUniformLocation(program, 'normalMatrix'),
    lightDirection: gl.getUniformLocation(program, 'lightDirection'),
    instanced: gl.getUniformLocation(program, 'instanced'),
    sphereNormalScale: gl.getUniformLocation(program, 'sphereNormalScale'),
    drawAlpha: gl.getUniformLocation(program, 'drawAlpha'),
    vertexAlphaEnabled: gl.getUniformLocation(program, 'vertexAlphaEnabled')
  };
  const buffer = gl.createBuffer();
  const lineBuffer = gl.createBuffer();
  const overlayBuffer = gl.createBuffer();
  const transparentFallbackBuffer = gl.createBuffer();
  const sphereBuffer = gl.createBuffer();
  const transparentSphereBuffer = gl.createBuffer();
  const cursorSphereBuffer = gl.createBuffer();
  const instanceBuffer = gl.createBuffer();
  const uploadScratchByBuffer = new WeakMap();
  function uploadScratch(buffer, values) {
    let scratch = uploadScratchByBuffer.get(buffer);
    if (!scratch || scratch.length < values.length) {
      const capacity = Math.max(values.length, scratch ? Math.floor(scratch.length * 1.5) : 0);
      scratch = new Float32Array(capacity);
      uploadScratchByBuffer.set(buffer, scratch);
    }
    scratch.set(values);
    return scratch.subarray(0, values.length);
  }
  const instancing = gl.getExtension('ANGLE_instanced_arrays');
  const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuRenderer = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const TAU = Math.PI * 2;
  const CONFIG_SCALE = 0.1;
  // Channel correction measured from isolated original and Flow arrow captures
  // at the matched 800 by 800 view.
  const ARROW_COLOR_COMPENSATION = 1.3;
  const CAMERA_DISTANCE = 5;
  const FOV = 10 * Math.PI / 180;
  let renderSerial = 0;
  let lastOrderedGlErrors = [];

  function hexRgb(hex) {
    const packed = Number.parseInt(hex.slice(1), 16);
    return [(packed >> 16 & 255) / 255, (packed >> 8 & 255) / 255, (packed & 255) / 255];
  }
  function nodeRgb(node) { return node.colorRGB || hexRgb(node.color); }
  function vertex(out, p, n, c, alpha = 1) { out.push(p[0], p[1], p[2], n[0], n[1], n[2], c[0], c[1], c[2], alpha); }
  function triangle(out, a, b, c, na, nb, nc, color, alpha = 1) {
    vertex(out, a, na, color, alpha); vertex(out, b, nb, color, alpha); vertex(out, c, nc, color, alpha);
  }
  function line(out, a, b, color) {
    const normal = [0, 0, 1];
    vertex(out, a, normal, color);
    vertex(out, b, normal, color);
  }
  // OG's get_rainbow helper maps scalar values from blue through red to yellow.
  function rainbow(value, minimum, maximum) {
    const t = maximum > minimum ? Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum))) : 0.5;
    if (t < 0.5) return [t * 2, 0, 1 - t * 2];
    if (t < 1) return [1, t * 2 - 0.5, 0];
    return [1, 1, 0];
  }
  // GLUT's sphere mesh uses Z as its polar axis. Keep that orientation because
  // the low polygon count makes the mesh orientation visible in the OG view.
  // Preserve the native macOS GLUT azimuth phase measured against OG captures.
  const spherePoint = (phi, theta) => [Math.sin(phi) * Math.sin(theta), Math.sin(phi) * Math.cos(theta), Math.cos(phi)];
  function makeSphereMesh(stacks, slices) {
    const mesh = [];
    const addVertex = (p, n) => mesh.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    if (slices < 1 || stacks < 2) return mesh;
    const vertices = [[0, 0, 1]];
    for (let stack = 1; stack < stacks; stack++) {
      const phi = Math.PI * stack / stacks;
      for (let slice = 0; slice < slices; slice++) {
        const theta = TAU * slice / slices;
        vertices.push(spherePoint(phi, theta));
      }
    }
    vertices.push([0, 0, -1]);
    const triangleStrip = indices => {
      for (let index = 0; index < indices.length - 2; index++) {
        const order = index % 2 ? [index + 1, index, index + 2] : [index, index + 1, index + 2];
        for (const vertexIndex of order) addVertex(vertices[indices[vertexIndex]], vertices[indices[vertexIndex]]);
      }
    };
    triangleStrip(Array.from({length:slices},(_,slice)=>[slice+1,0]).flat().concat([1,0]));
    for (let stack = 0; stack < stacks - 2; stack++) {
      const upper = 1 + stack * slices, lower = upper + slices;
      for (let slice = 0; slice < slices; slice++) {
        const next = (slice + 1) % slices;
        for (const index of [upper + slice, lower + slice, lower + next, upper + slice, lower + next, upper + next]) {
          addVertex(vertices[index], vertices[index]);
        }
      }
    }
    const bottomOffset = 1 + (stacks - 2) * slices, bottomIndex = vertices.length - 1, bottom = [];
    for (let slice = 0; slice < slices; slice++) bottom.push(bottomIndex, bottomOffset + slice);
    bottom.push(bottomIndex, bottomOffset);
    triangleStrip(bottom);
    return mesh;
  }
  const sphereMesh = makeSphereMesh(10, 10), transparentSphereMesh = makeSphereMesh(30, 10), cursorMesh = makeSphereMesh(4, 4);
  const sphereMeshes = new Map([[`10:10`, sphereMesh], [`30:10`, transparentSphereMesh], [`4:4`, cursorMesh]]);
  gl.bindBuffer(gl.ARRAY_BUFFER, sphereBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sphereMesh), gl.STATIC_DRAW);
  const sphereVertexCount = sphereMesh.length / 6;
  gl.bindBuffer(gl.ARRAY_BUFFER, transparentSphereBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(transparentSphereMesh), gl.STATIC_DRAW);
  const transparentSphereVertexCount = transparentSphereMesh.length / 6;
  gl.bindBuffer(gl.ARRAY_BUFFER, cursorSphereBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cursorMesh), gl.STATIC_DRAW);
  const cursorSphereVertexCount = cursorMesh.length / 6;
  function sphere(out, center, radius, color, axis = [1, 0, 0], elongation = 1, stacks = 10, slices = 10, alpha = 1) {
    if (!(radius > 0)) return;
    const mesh = sphereMeshes.get(`${stacks}:${slices}`) || makeSphereMesh(stacks, slices);
    const normalize = v => { const length = Math.hypot(...v); return length ? v.map(x => x / length) : [1, 0, 0]; };
    const a = normalize(axis);
    const rotateFromX = value => {
      const cosine = Math.max(-1, Math.min(1, a[0])), turnAxis = [0, -a[2], a[1]], sine = Math.hypot(...turnAxis);
      if (sine < 1e-6) return cosine >= 0 ? value : [-value[0], value[1], -value[2]];
      const k = turnAxis.map(component => component / sine);
      const cross = [k[1] * value[2] - k[2] * value[1], k[2] * value[0] - k[0] * value[2], k[0] * value[1] - k[1] * value[0]];
      const dot = k[0] * value[0] + k[1] * value[1] + k[2] * value[2];
      return value.map((component, i) => component * cosine + cross[i] * sine + k[i] * dot * (1 - cosine));
    };
    const stretch = Math.max(1, elongation);
    const point = n => rotateFromX([n[0] * stretch, n[1] / stretch, n[2] / stretch]);
    // OG leaves GL_NORMALIZE disabled, so inverse-scaled ellipsoid normals
    // retain their transformed length before the model-view normal transform.
    // Match OG sphere normals, whose coordinates are scaled before model-view.
    const normal = n => rotateFromX([n[0] / stretch, n[1] * stretch, n[2] * stretch]).map(value => value * CONFIG_SCALE);
    for (let offset = 0; offset < mesh.length; offset += 6) {
      const unit = mesh.slice(offset, offset + 3), sourceNormal = mesh.slice(offset + 3, offset + 6);
      const localPosition = point(unit), localNormal = normal(sourceNormal);
      vertex(out, center.map((value, i) => value + localPosition[i] * radius), localNormal, color, alpha);
    }
  }
  function halfCylinder(out, lineOut, first, second, radiusA, radiusB, color) {
    const dx = second[0] - first[0], dy = second[1] - first[1], dz = second[2] - first[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-9 || radiusA <= 0 || radiusB <= 0) return;
    const axis = [dx / length, dy / length, dz / length];
    let u = [0, -dz, dy];
    let um = Math.hypot(...u);
    if (um < 1e-9) { u = [-dz, 0, dx]; um = Math.hypot(...u); }
    u = u.map(x => x / um);
    const v = [axis[1] * u[2] - axis[2] * u[1], axis[2] * u[0] - axis[0] * u[2], axis[0] * u[1] - axis[1] * u[0]];
    const segments = 10;
    const drawOrder = [];
    for (let i = 0; i < segments; i++) {
      const surfaceFirst = out.length / 10, outlineFirst = lineOut.length / 10;
      const a0 = TAU * i / segments, a1 = TAU * (i + 1) / segments;
      const radial = a => [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
      const n0 = radial(a0), n1 = radial(a1);
      const p0 = [first[0] + n0[0] * radiusA, first[1] + n0[1] * radiusA, first[2] + n0[2] * radiusA];
      const p1 = [first[0] + n1[0] * radiusA, first[1] + n1[1] * radiusA, first[2] + n1[2] * radiusA];
      const p2 = [second[0] + n1[0] * radiusB, second[1] + n1[1] * radiusB, second[2] + n1[2] * radiusB];
      const p3 = [second[0] + n0[0] * radiusB, second[1] + n0[1] * radiusB, second[2] + n0[2] * radiusB];
      const tangent = p1.map((value, i) => value - p0[i]);
      const diagonal = p2.map((value, i) => value - p0[i]);
      const sideNormal = [tangent[1] * diagonal[2] - tangent[2] * diagonal[1], tangent[2] * diagonal[0] - tangent[0] * diagonal[2], tangent[0] * diagonal[1] - tangent[1] * diagonal[0]];
      const startCapA = p0.map((value, i) => value - first[i]), startCapB = p1.map((value, i) => value - first[i]);
      const endCapA = p3.map((value, i) => value - second[i]), endCapB = p2.map((value, i) => value - second[i]);
      const capNormal = vector => vector.map(Math.abs);
      const startNormal = capNormal([startCapA[1] * startCapB[2] - startCapA[2] * startCapB[1], startCapA[2] * startCapB[0] - startCapA[0] * startCapB[2], startCapA[0] * startCapB[1] - startCapA[1] * startCapB[0]]);
      const endNormal = capNormal([endCapA[1] * endCapB[2] - endCapA[2] * endCapB[1], endCapA[2] * endCapB[0] - endCapA[0] * endCapB[2], endCapA[0] * endCapB[1] - endCapA[1] * endCapB[0]]);
      triangle(out, first, p0, p1, startNormal, startNormal, startNormal, color);
      triangle(out, second, p3, p2, endNormal, endNormal, endNormal, color);
      triangle(out, p0, p1, p2, sideNormal, sideNormal, sideNormal, color);
      triangle(out, p0, p2, p3, sideNormal, sideNormal, sideNormal, color);
      const black = [0, 0, 0];
      vertex(lineOut, p0, n0, black); vertex(lineOut, p1, n1, black);
      vertex(lineOut, p3, n0, black); vertex(lineOut, p2, n1, black);
      drawOrder.push({ mode: 'triangles', first: surfaceFirst, count: out.length / 10 - surfaceFirst });
      drawOrder.push({ mode: 'lines', first: outlineFirst, count: lineOut.length / 10 - outlineFirst });
    }
    return drawOrder;
  }
  function taperedCylinder(out, lineOut, first, second, radiusA, radiusB, color) {
    const delta = second.map((value, i) => value - first[i]);
    const length = Math.hypot(...delta);
    if (length < 1e-9) return;
    const axis = delta.map(value => value / length);
    let initial = [0, -axis[2], axis[1]];
    let initialLength = Math.hypot(...initial);
    // The original arrow() routine divides by zero for an axis parallel to X.
    // Keep its basis for normal cases and choose a stable perpendicular there.
    if (initialLength < 1e-9) {
      initial = Math.abs(axis[0]) < 0.9 ? [0, -axis[2], axis[1]] : [0, 0, 1];
      initialLength = Math.hypot(...initial);
    }
    initial = initial.map(value => value / initialLength);
    const cross = [axis[1] * initial[2] - axis[2] * initial[1], axis[2] * initial[0] - axis[0] * initial[2], axis[0] * initial[1] - axis[1] * initial[0]];
    const axisDotInitial = axis[0] * initial[0] + axis[1] * initial[1] + axis[2] * initial[2];
    const segments = 6;
    const drawOrder = [];
    for (let i = 0; i < segments; i++) {
      const surfaceFirst = out.length / 10, outlineFirst = lineOut.length / 10;
      const a0 = TAU * i / segments, a1 = TAU * (i + 1) / segments;
      const radial = angle => initial.map((value, j) => value * Math.cos(angle) + cross[j] * Math.sin(angle) + axis[j] * axisDotInitial * (1 - Math.cos(angle)));
      const n0 = radial(a0), n1 = radial(a1);
      const p00 = first.map((value, j) => value + n0[j] * radiusA), p01 = first.map((value, j) => value + n1[j] * radiusA);
      const p10 = second.map((value, j) => value + n0[j] * radiusB), p11 = second.map((value, j) => value + n1[j] * radiusB);
      const sourceNormal = (a, b, c) => {
        const ab = b.map((value, j) => value - a[j]), ac = c.map((value, j) => value - a[j]);
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const magnitude = Math.hypot(...normal);
        // OG normalizes each arrow face and takes the absolute components.
        // The Flow model-view scale is 0.1, so scale the input normal by 0.1.
        return magnitude ? normal.map(value => Math.abs(value) / magnitude * CONFIG_SCALE) : [0, 0, 0];
      };
      const startNormal = sourceNormal(first, p00, p01);
      const endNormal = sourceNormal(second, p10, p11);
      const arrowSideNormal = sourceNormal(p00, p01, p11);
      triangle(out, first, p00, p01, startNormal, startNormal, startNormal, color);
      triangle(out, second, p10, p11, endNormal, endNormal, endNormal, color);
      triangle(out, p00, p01, p11, arrowSideNormal, arrowSideNormal, arrowSideNormal, color);
      triangle(out, p00, p11, p10, arrowSideNormal, arrowSideNormal, arrowSideNormal, color);
      const black = [0, 0, 0];
      vertex(lineOut, p00, n0, black); vertex(lineOut, p01, n1, black);
      vertex(lineOut, p10, n0, black); vertex(lineOut, p11, n1, black);
      drawOrder.push({ mode: 'triangles', first: surfaceFirst, count: out.length / 10 - surfaceFirst });
      drawOrder.push({ mode: 'lines', first: outlineFirst, count: lineOut.length / 10 - outlineFirst });
    }
    return drawOrder;
  }
  function boxGrid(out, spacing, count) {
    if (!(spacing > 0) || count < 1) return;
    const edge = spacing * (count + 0.5), color = [1, 1, 1], normal = [0, 0, 1];
    for (let j = -count - 1; j <= count; j++) for (let k = -count - 1; k <= count; k++) {
      const y = spacing * (j + 0.5), z = spacing * (k + 0.5);
      vertex(out, [-edge, y, z], normal, color); vertex(out, [edge, y, z], normal, color);
    }
    for (let i = -count - 1; i <= count; i++) for (let k = -count - 1; k <= count; k++) {
      const x = spacing * (i + 0.5), z = spacing * (k + 0.5);
      vertex(out, [x, -edge, z], normal, color); vertex(out, [x, edge, z], normal, color);
    }
    for (let i = -count - 1; i <= count; i++) for (let j = -count - 1; j <= count; j++) {
      const x = spacing * (i + 0.5), y = spacing * (j + 0.5);
      vertex(out, [x, y, -edge], normal, color); vertex(out, [x, y, edge], normal, color);
    }
  }
  function displayBox(out, bounds) {
    if (!bounds) return;
    const x0 = bounds.minx, x1 = bounds.maxx;
    const y0 = bounds.miny, y1 = bounds.maxy;
    const z0 = bounds.minz, z1 = bounds.maxz;
    const corners = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const green = [0,1,0], normal = [0,0,1];
    for (const [a,b] of edges) {
      vertex(out, corners[a], normal, green);
      vertex(out, corners[b], normal, green);
    }
  }
  function matrixForScene(yaw, pitch, zoom, panX, panY, width, height, cameraDistance = CAMERA_DISTANCE, shiftX = 0, shiftY = 0) {
    const aspect = width / Math.max(1, height), f = 1 / Math.tan(FOV / 2), near = 0.1, far = 1000;
    const projection = new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0
    ]);
    const axisX = Math.cos(yaw), axisY = -Math.sin(yaw);
    const cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(yaw), sz = Math.sin(yaw);
    const t = 1 - cx;
    const a00 = cx + axisX * axisX * t, a01 = axisX * axisY * t, a02 = axisY * sx;
    const a10 = axisY * axisX * t, a11 = cx + axisY * axisY * t, a12 = -axisX * sx;
    const r20 = -axisY * sx, r21 = axisX * sx, r22 = cx;
    const r00 = cz * a00 - sz * a10, r01 = cz * a01 - sz * a11, r02 = cz * a02 - sz * a12;
    const r10 = sz * a00 + cz * a10, r11 = sz * a01 + cz * a11, r12 = sz * a02 + cz * a12;
    const tx = shiftX + panX * 0.01;
    const ty = shiftY - panY * 0.01;
    const scale = CONFIG_SCALE;
    const modelView = new Float32Array([
      r00 * scale, r10 * scale, r20 * scale, 0,
      r01 * scale, r11 * scale, r21 * scale, 0,
      r02 * scale, r12 * scale, r22 * scale, 0,
      tx, ty, -cameraDistance / zoom, 1
    ]);
    return { projection, modelView };
  }
  function resize() {
    const rect = canvas.getBoundingClientRect(), ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    return { width, height };
  }
  function render(nodes, options) {
    const { width, height } = resize();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    const vertices = [], cylinderLines = [], gridLines = [], arrowVertices = [], arrowLines = [], underlayLines = [], shellVertices = [], springLines = [], overlayLines = [], sliceVertices = [], instances = [], transparentInstances = [], transparentFallbackVertices = [], cursorFallbackVertices = [], centroidFallbackVertices = [], cursorDrawInstances = [];
    const nodeInstanceById = new Map(), nodeInstanceOffsetById = new Map(), nodeGeometryById = new Map(), transparentInstanceById = new Map(), transparentGeometryById = new Map(), transparentInstanceOffsetById = new Map(), arrowGeometryByNode = new Map(), centroidDrawInstances = [];
    const orderedRendering = Boolean(options.showArrows || options.showTransparentSpheres || (options.showNodes && options.showCylinders) || (options.cursor?.enabled && instancing));
    const captureOverlayOrder = Boolean(options.showArrows || options.showTransparentSpheres);
    let ellipticalInstances = 0, transparentSphereCount = 0, centroidInstances = 0, arrowCount = 0, cursorInstances = 0;
    const arrowVectors = [], movementVectors = [], transparentRadii = [], transparentDisplayRadii = [], transparentDrawOrder = [];
    // OG draw_func walks node indices from 1 through nd. Preserve that order
    // for transparent blending even when the 2D fallback has depth-sorted its
    // frame for painting.
    const visible = [];
    const allById = [];
    const visibleById = [];
    const positions = [];
    let nodesOrdered = true;
    let previousNodeId = -Infinity;
    for (const n of nodes) {
      if (n.id < previousNodeId) nodesOrdered = false;
      previousNodeId = n.id;
      allById[n.id] = n;
      if (!n.visible || !n.display) continue;
      visible.push(n);
      visibleById[n.id] = n;
      positions[n.id] = [n.x, n.y, n.z];
    }
    if (!nodesOrdered) visible.sort((a, b) => a.id - b.id);
    if (options.showNodes && options.showCylinders) {
      for (const n of visible) {
        const other = allById[n.other];
        if (!other || n.type > 2 || other.type > 2) continue;
        const a = [n.x, n.y, n.z], b = [other.x, other.y, other.z];
        const middle = a.map((value, i) => (value + b[i]) * 0.5);
        const ra = n.radius * options.pointScale;
        const rb = other.radius * options.pointScale;
        const rm = (ra + rb) * 0.5;
        const delta = b.map((value, i) => value - a[i]);
        const d = Math.hypot(...delta);
        if (d > 1e-9) {
          const unit = delta.map(x => x / d);
          const start = a.map((value, i) => value - unit[i] * ra);
          const surface = [], outline = [];
          const drawOrder = halfCylinder(surface, outline, start, middle, ra, rm, nodeRgb(n));
          vertices.push(...surface);
          cylinderLines.push(...outline);
          nodeGeometryById.set(n.id, { surface, outline, drawOrder, kind: 'cylinder' });
        }
      }
    }
    if (options.showBox) displayBox(underlayLines, options.sectionBounds || options.bounds);
    const shell = options.eggshell;
    let shellTriangleCount = 0;
    if (options.showEggshell && shell?.points?.length && shell?.triangles?.length && (options.sectionBounds || options.bounds)) {
      const points = shell.points, triangles = shell.triangles;
      const clip = options.sectionBounds || options.bounds;
      for (let i = 0; i < triangles.length; i++) {
        const ids = triangles[i].map(index => index - (shell.oneBased === false ? 0 : 1));
        const p = ids.map(index => points[index]);
        if (p.some(point => !point || point[0] < clip.minx || point[0] > clip.maxx || point[1] < clip.miny || point[1] > clip.maxy || point[2] < clip.minz || point[2] >= clip.maxz)) continue;
        const rawNormal = [(p[1][1]-p[0][1])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][1]-p[0][1]), (p[1][2]-p[0][2])*(p[2][0]-p[0][0])-(p[1][0]-p[0][0])*(p[2][2]-p[0][2]), (p[1][0]-p[0][0])*(p[2][1]-p[0][1])-(p[1][1]-p[0][1])*(p[2][0]-p[0][0])];
        const normalLength = Math.hypot(...rawNormal), normal = rawNormal.map(value => normalLength ? Math.abs(value / normalLength) : 0);
        const color = rainbow(i + 1, 1, shell.colorMaximum ?? (options.cells?.length || 1));
        triangle(shellVertices, ...p, normal, normal, normal, color);
        shellTriangleCount++;
      }
    }
    if (options.showGrid) boxGrid(gridLines, options.gridSpacing, options.gridCount);
    if (options.showNodes && !options.noBalls) {
      for (const n of visible) {
        if (options.showCylinders && n.type < 3) continue;
        const radius = (options.smallBalls ? n.addRadius * 0.1 : n.radius) * options.pointScale;
        const color = nodeRgb(n);
        const rawAxis = [n.polx, n.poly, n.polz], hasPolarization = Math.hypot(...rawAxis) > 1e-12;
        const axis = hasPolarization ? rawAxis : [1, 0, 0];
        const elongation = options.showEllipses && hasPolarization ? Math.max(1, n.elongationFactor || 1) : 1;
        if (elongation > 1) ellipticalInstances++;
        if (instancing) {
          const instance = [n.x, n.y, n.z, radius, color[0], color[1], color[2], ...axis, elongation, 1];
          instances.push(...instance);
          nodeInstanceById.set(n.id, instance);
          nodeInstanceOffsetById.set(n.id, instances.length - instance.length);
          if (orderedRendering && !instancing) {
            const geometry = { surface: [], outline: [], kind: 'sphere' };
            sphere(geometry.surface, [n.x, n.y, n.z], radius, color, axis, elongation);
            nodeGeometryById.set(n.id, geometry);
          }
        }
        else {
          const geometry = { surface: [], outline: [], kind: 'sphere' };
          sphere(geometry.surface, [n.x, n.y, n.z], radius, color, axis, elongation);
          vertices.push(...geometry.surface);
          nodeGeometryById.set(n.id, geometry);
        }
      }
    }
    if (options.showArrows && options.showNodes) {
      const [minimum, maximum] = options.arrowRange || [0, 0], span = maximum - minimum, scale = options.arrowScale ?? 1;
      if (span > 0) for (const n of visible) {
        if (n.type > 2) continue;
        const other = allById[n.other];
        if (!other || other.type > 2) continue;
        const value = Number(n.arrowValue) || 0;
        const length = scale * (value - minimum) / span;
        const origin = [n.x, n.y, n.z], target = [other.x, other.y, other.z], direction = origin.map((coordinate, i) => coordinate - target[i]);
        const distance = Math.hypot(...direction);
        if (!length || !distance) continue;
        const unit = direction.map(component => component / distance);
        const end = origin.map((coordinate, i) => coordinate + unit[i] * length);
        const tip = end.map((coordinate, i) => coordinate + unit[i] * 0.3);
        arrowVectors.push({ nodeId: n.id, origin: [...origin], end: [...end], tip: [...tip] });
        const color = nodeRgb(n).map(channel => Math.min(1, channel * ARROW_COLOR_COMPENSATION));
        const arrowSurface = [], arrowOutline = [], arrowDrawOrder = [];
        for (const [start, finish, radiusStart, radiusFinish] of [[origin, end, 0.03, 0.03], [end, tip, 0.06, 0.001]]) {
          for (const part of taperedCylinder(arrowSurface, arrowOutline, start, finish, radiusStart, radiusFinish, color)) {
            // taperedCylinder receives the accumulated arrays and returns absolute
            // offsets into them. Adding the second cylinder's offset here sends
            // its arrowhead draws past this arrow and into later node geometry.
            arrowDrawOrder.push(part);
          }
        }
        arrowVertices.push(...arrowSurface);
        arrowLines.push(...arrowOutline);
        arrowGeometryByNode.set(n.id, { surface: arrowSurface, outline: arrowOutline, drawOrder: arrowDrawOrder });
        arrowCount++;
      }
    }
    if (options.showTransparentSpheres && options.showNodes) {
      const [minimum, maximum] = options.transparentRange || [0, 0];
      const span = maximum - minimum;
      const scale = options.transparentScale ?? 1;
      for (const n of visible) {
        if (n.type > 2) continue;
        const value = Number(n.transparentValue) || 0;
        const normalized = span > 0 ? (value - minimum) / span : 0;
        // OG passes smax_scale * normalized to the sphere after translating
        // the center by esca. modelView already applies esca to its radius.
        const radius = scale * normalized;
        if (!radius) continue;
        transparentRadii.push(radius);
        transparentDisplayRadii.push(radius * CONFIG_SCALE);
        const color = nodeRgb(n);
        const instance = [n.x, n.y, n.z, radius, color[0], color[1], color[2], 1, 0, 0, 1, 0.25];
        transparentInstances.push(...instance);
        transparentInstanceById.set(n.id, instance);
        transparentInstanceOffsetById.set(n.id, instances.length + transparentInstances.length - instance.length);
        if (orderedRendering) {
          const geometry = { surface: [], outline: [], kind: 'transparent' };
          sphere(geometry.surface, [n.x, n.y, n.z], radius, color, [1, 0, 0], 1, 30, 10, 0.25);
          transparentGeometryById.set(n.id, geometry);
        }
        else if (!instancing) sphere(transparentFallbackVertices, [n.x, n.y, n.z], radius, color, [1, 0, 0], 1, 30, 10, 0.25);
        transparentSphereCount++;
      }
    }
    if (options.showCentroids) {
      const firstNodeByCell = new Map();
      for (const n of nodes) if (!firstNodeByCell.has(n.cell)) firstNodeByCell.set(n.cell, n);
      for (const cell of options.cells || []) {
        const firstNode = firstNodeByCell.get(cell.id);
        if (!(cell.visible ?? firstNode?.visible)) continue;
        const instance = [cell.x, cell.y, cell.z, 0.1, 1, 1, 1, 1, 0, 0, 1, 1];
        if (instancing) centroidDrawInstances.push(...instance);
        else sphere(centroidFallbackVertices, [cell.x, cell.y, cell.z], 0.1, [1, 1, 1]);
        centroidInstances++;
      }
    }
    const slices = options.slicePlots || [];
    for (const slice of slices) {
      const samples = slice.samples || [], values = samples.map(sample => sample.value);
      const minimum = slice.minimum ?? values.reduce((low, value) => Math.min(low, value), Infinity);
      const maximum = slice.maximum ?? values.reduce((high, value) => Math.max(high, value), -Infinity);
      for (const sample of samples) {
        let point = [...sample.position];
        if (slice.surface) {
          const axis = slice.axis === 'x' ? 0 : slice.axis === 'y' ? 1 : 2;
          point[axis] = ((slice.plane ?? 0) + sample.value) * (slice.axis === 'z' ? 1e-5 : 1e-7);
        }
        const color = rainbow(sample.value, minimum, maximum);
        vertex(sliceVertices, point, [0, 0, 1], color);
      }
    }
    if (options.cursor?.enabled) {
      const cursor = options.cursor;
      // OG places the cursor at coordinates multiplied by esca, then draws a
      // sphere with radius 0.03 in display coordinates. The scene scale is 0.1.
      if (instancing) cursorDrawInstances.push(cursor.x, cursor.y, cursor.z, 0.3, 1, 0, 0, 1, 0, 0, 1, 1);
      else sphere(cursorFallbackVertices, [cursor.x, cursor.y, cursor.z], 0.3, [1, 0, 0], [1, 0, 0], 1, 4, 4);
      cursorInstances = 1;
    }
    if (options.showPolarization) {
      const firstNodeByCell = new Map();
      for (const n of nodes) if (!firstNodeByCell.has(n.cell)) firstNodeByCell.set(n.cell, n);
      for (const cell of options.cells || []) {
        const firstNode = firstNodeByCell.get(cell.id);
        if (!(cell.visible ?? firstNode?.visible) || !(cell.display ?? firstNode?.display)) continue;
        line(underlayLines, [cell.x, cell.y, cell.z], [cell.x + cell.polx, cell.y + cell.poly, cell.z + cell.polz], [1, 0, 0]);
      }
    }
    if (options.showSprings) {
      const drawn = new Set();
      for (const n of visible) {
        const other = visibleById[n.other];
        if (!other || n.type > 2 || other.type > 2 || drawn.has(n.id)) continue;
        drawn.add(n.id); drawn.add(other.id);
        line(springLines, positions[n.id], positions[other.id], [0, 1, 0]);
      }
    }
    if (options.showInterConnections || options.showIntraConnections) {
      for (const edge of options.edges || []) {
        if (edge.inter ? !options.showInterConnections : !options.showIntraConnections) continue;
        const a = visibleById[edge.a], b = visibleById[edge.b];
        if (!a || !b) continue;
        const color = edge.inter ? (a.type === 1 ? [1, 0, 0] : [0, 1, 0]) : (a.type === b.type ? [0, 0.75, 0] : [0.75, 0, 0]);
        line(overlayLines, positions[a.id], positions[b.id], color);
      }
    }
    if (options.showDisplacement) {
      for (const n of visible) if (!n.fixed) line(overlayLines, positions[n.id], [n.x0, n.y0, n.z0], [0, 1, 0]);
    }
    const maxMagnitude = (x, y, z) => {
      let maximum = 0;
      for (const n of nodes) maximum = Math.max(maximum, Math.hypot(n[x], n[y], n[z]));
      return maximum;
    };
    if (options.showMovementVectors || options.showUnitMovement) {
      let maximumForce = 0;
      for (const n of nodes) maximumForce = Math.max(maximumForce, n.moveMagnitude || 0);
      for (const n of visible) {
        const magnitude = Math.hypot(n.moveX, n.moveY, n.moveZ);
        if (!magnitude) continue;
        const scale = options.showMovementVectors ? (maximumForce > 0 ? 20 / maximumForce : 0) : 1 / magnitude;
        const start = positions[n.id], end = [n.x + n.moveX * scale, n.y + n.moveY * scale, n.z + n.moveZ * scale];
        line(underlayLines, start, end, [1, 0, 0]);
        if (options.showMovementVectors) movementVectors.push({ nodeId: n.id, start: [...start], end });
      }
    }
    for (const [enabled, x, y, z, color] of [
      [options.showRepulsion, 'repX', 'repY', 'repZ', [1, 1, 0]],
      [options.showLateralForce, 'lateralX', 'lateralY', 'lateralZ', [0.5, 1, 0]],
      [options.showAxialForce, 'axialX', 'axialY', 'axialZ', [1, 0, 0]]
    ]) {
      if (!enabled) continue;
      const maximum = maxMagnitude(x, y, z);
      if (!(maximum > 0)) continue;
      const scale = 2 / maximum;
      for (const n of visible) {
        if (!Math.hypot(n[x], n[y], n[z])) continue;
        line(underlayLines, positions[n.id], [n.x + n[x] * scale, n.y + n[y] * scale, n.z + n[z] * scale], color);
      }
    }
    const orderedSurfaceVertices = [], orderedDraws = [], orderedCommands = [], nodeLoopOrder = [];
    const appendOrderedGeometry = (nodeId, layer, geometry) => {
      if (!geometry) return;
      if (geometry.drawOrder?.length) {
        const surfaceFirst = orderedSurfaceVertices.length / 10;
        for (const value of geometry.surface) orderedSurfaceVertices.push(value);
        const outlineFirst = orderedSurfaceVertices.length / 10;
        for (const value of geometry.outline || []) orderedSurfaceVertices.push(value);
        for (const part of geometry.drawOrder) {
          const first = (part.mode === 'lines' ? outlineFirst : surfaceFirst) + part.first;
          const command = { nodeId, layer: part.mode === 'lines' ? `${layer}-outline` : layer, mode: part.mode, first, count: part.count };
          orderedCommands.push(command);
        }
        if (captureOverlayOrder) orderedDraws.push({ nodeId, layer, first: surfaceFirst, count: geometry.surface.length / 10 + (geometry.outline?.length || 0) / 10 });
        return;
      }
      if (geometry.surface.length) {
        const first = orderedSurfaceVertices.length / 10;
        for (const value of geometry.surface) orderedSurfaceVertices.push(value);
        const command = { nodeId, layer, mode: 'triangles', first, count: geometry.surface.length / 10 };
        orderedCommands.push(command);
        if (captureOverlayOrder) orderedDraws.push({ nodeId, layer, first, count: command.count });
      }
      if (geometry.outline?.length) {
        const first = orderedSurfaceVertices.length / 10;
        for (const value of geometry.outline) orderedSurfaceVertices.push(value);
        orderedCommands.push({ nodeId, layer: `${layer}-outline`, mode: 'lines', first, count: geometry.outline.length / 10 });
      }
    };
    const appendOrderedInstance = nodeId => {
      const offset = nodeInstanceOffsetById.get(nodeId);
      if (offset === undefined) return;
      const previous = orderedCommands.at(-1);
      if (previous?.mode === 'instances' && previous.instanceOffset + previous.instanceCount * 12 === offset) previous.instanceCount++;
      else orderedCommands.push({ nodeId, layer: 'node', mode: 'instances', instanceOffset: offset, instanceCount: 1 });
      if (captureOverlayOrder) orderedDraws.push({ nodeId, layer: 'node', first: offset / 12, count: sphereVertexCount });
    };
    if (orderedRendering) {
      const nodeOrder = nodesOrdered ? nodes : [...nodes].sort((a, b) => a.id - b.id);
      for (const n of nodeOrder) {
        // OG emits its cursor marker at the start of every node's draw_func
        // loop, before that node's visibility and type checks.
        if (options.cursor?.enabled && cursorDrawInstances.length) {
          const instanceOffset = instances.length;
          instances.push(...cursorDrawInstances);
          orderedCommands.push({ nodeId: n.id, layer: 'cursor', mode: 'cursor-instance', instanceOffset, instanceCount: 1 });
          nodeLoopOrder.push({ nodeId: n.id, layer: 'cursor' });
        }
        if (!visibleById[n.id]) continue;
        if (nodeInstanceById.has(n.id)) {
          appendOrderedInstance(n.id);
          nodeLoopOrder.push({ nodeId: n.id, layer: 'node' });
        } else {
          const geometry = nodeGeometryById.get(n.id);
          appendOrderedGeometry(n.id, 'node', geometry);
          if (geometry) nodeLoopOrder.push({ nodeId: n.id, layer: 'node' });
        }
        const arrow = arrowGeometryByNode.get(n.id);
        appendOrderedGeometry(n.id, 'arrow', arrow);
        if (arrow) nodeLoopOrder.push({ nodeId: n.id, layer: 'arrow' });
        const transparent = transparentGeometryById.get(n.id);
        appendOrderedGeometry(n.id, 'transparent', transparent);
        if (transparent) nodeLoopOrder.push({ nodeId: n.id, layer: 'transparent' });
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (!orderedRendering) gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(buffer, vertices), gl.DYNAMIC_DRAW);
    const stride = 10 * Float32Array.BYTES_PER_ELEMENT;
    for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
      gl.enableVertexAttribArray(attributes[name]);
      gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      if (instancing) instancing.vertexAttribDivisorANGLE(attributes[name], 0);
    }
    gl.enableVertexAttribArray(attributes.vertexAlpha);
    gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
    gl.disableVertexAttribArray(attributes.instanceCenter);
    gl.disableVertexAttribArray(attributes.instanceRadius);
    gl.disableVertexAttribArray(attributes.instanceAxis);
    gl.disableVertexAttribArray(attributes.instanceElongation);
    gl.disableVertexAttribArray(attributes.instanceAlpha);
    gl.vertexAttrib3f(attributes.instanceCenter, 0, 0, 0);
    gl.vertexAttrib1f(attributes.instanceRadius, 1);
    gl.vertexAttrib3f(attributes.instanceAxis, 1, 0, 0);
    gl.vertexAttrib1f(attributes.instanceElongation, 1);
    gl.vertexAttrib1f(attributes.instanceAlpha, 1);
    gl.uniform1f(uniforms.instanced, 0);
    gl.uniform1f(uniforms.drawAlpha, 1);
    gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
    const cameraDistance = options.cameraDistance ?? CAMERA_DISTANCE;
    const matrices = matrixForScene(options.yaw, options.pitch, options.zoom, options.panX, options.panY, width, height, cameraDistance, options.cameraShiftX, options.cameraShiftY);
    gl.uniformMatrix4fv(uniforms.projection, false, matrices.projection);
    gl.uniformMatrix4fv(uniforms.modelView, false, matrices.modelView);
    const inverseScaleSquared = 1 / (CONFIG_SCALE * CONFIG_SCALE);
    const model = matrices.modelView;
    gl.uniformMatrix3fv(uniforms.normalMatrix, false, new Float32Array([
      model[0] * inverseScaleSquared, model[1] * inverseScaleSquared, model[2] * inverseScaleSquared,
      model[4] * inverseScaleSquared, model[5] * inverseScaleSquared, model[6] * inverseScaleSquared,
      model[8] * inverseScaleSquared, model[9] * inverseScaleSquared, model[10] * inverseScaleSquared
    ]));
    gl.uniform3f(uniforms.lightDirection, 1.5, -0.5, 2.0);
    gl.uniform1f(uniforms.sphereNormalScale, CONFIG_SCALE);
    const renderOrder = [];
    const ogStageOrder = [];
    const drawRawGeometry = (surface, outline = []) => {
      for (const [data, target, mode] of [[surface, buffer, gl.TRIANGLES], [outline, lineBuffer, gl.LINES]]) {
        if (!data.length) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, target);
        gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(target, data), gl.DYNAMIC_DRAW);
        for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
          gl.enableVertexAttribArray(attributes[name]);
          gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
        }
        gl.enableVertexAttribArray(attributes.vertexAlpha);
        gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
        gl.uniform1f(uniforms.instanced, 0);
        gl.uniform1f(uniforms.drawAlpha, 1);
        gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
        gl.drawArrays(mode, 0, data.length / 10);
      }
    };
    const drawOrderedSurfaces = () => {
      if (!orderedCommands.length) return;
      const orderedGlErrors = [];
      let orderedGeometryBound = false;
      let blendEnabled = false;
      if (instancing && orderedCommands.some(command => command.mode === 'instances')) {
        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(instanceBuffer, instances), gl.DYNAMIC_DRAW);
      }
      const bindOrderedGeometry = () => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
          gl.enableVertexAttribArray(attributes[name]);
          gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
        }
        gl.enableVertexAttribArray(attributes.vertexAlpha);
        gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
        gl.uniform1f(uniforms.instanced, 0);
        gl.uniform1f(uniforms.drawAlpha, 1);
        gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
      };
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(buffer, orderedSurfaceVertices), gl.DYNAMIC_DRAW);
      for (const command of orderedCommands) {
        if (command.mode === 'instances') {
          if (blendEnabled) { gl.disable(gl.BLEND); blendEnabled = false; }
          drawInstances([], 1, sphereBuffer, sphereVertexCount, command.instanceOffset * Float32Array.BYTES_PER_ELEMENT, true, command.instanceCount);
          orderedGeometryBound = false;
          continue;
        }
        if (command.mode === 'cursor-instance') {
          if (blendEnabled) { gl.disable(gl.BLEND); blendEnabled = false; }
          drawInstances([], 1, cursorSphereBuffer, cursorSphereVertexCount, command.instanceOffset * Float32Array.BYTES_PER_ELEMENT, true, 1);
          orderedGeometryBound = false;
          continue;
        }
        if (!orderedGeometryBound) {
          bindOrderedGeometry();
          orderedGeometryBound = true;
        }
        const transparent = command.layer === 'transparent';
        if (transparent !== blendEnabled) {
          if (transparent) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          } else {
            gl.disable(gl.BLEND);
          }
          blendEnabled = transparent;
        }
        gl.drawArrays(command.mode === 'lines' ? gl.LINES : gl.TRIANGLES, command.first, command.count);
      }
      if (blendEnabled) gl.disable(gl.BLEND);
      // Reading the GL error queue inside this primitive loop synchronizes each
      // draw with the GPU. Drain it once after the ordered pass instead.
      while (orderedGlErrors.length < 32) {
        const error = gl.getError();
        if (error === gl.NO_ERROR) break;
        orderedGlErrors.push({ layer: 'ordered-pass', mode: 'pass', first: 0, count: orderedCommands.length, error });
      }
      return orderedGlErrors;
    };
    if (underlayLines.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(overlayBuffer, underlayLines), gl.DYNAMIC_DRAW);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform1f(uniforms.instanced, 0);
      gl.drawArrays(gl.LINES, 0, underlayLines.length / 10);
      renderOrder.push('underlay-lines');
      ogStageOrder.push('common-lines');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
    }
    if (shellVertices.length) {
      drawRawGeometry(shellVertices);
      renderOrder.push('eggshell');
      ogStageOrder.push('eggshell');
    }
    if (springLines.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(overlayBuffer, springLines), gl.DYNAMIC_DRAW);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform1f(uniforms.instanced, 0);
      gl.drawArrays(gl.LINES, 0, springLines.length / 10);
      renderOrder.push('epithelial-springs');
      ogStageOrder.push('epithelial-springs');
    }
    if (gridLines.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(overlayBuffer, gridLines), gl.DYNAMIC_DRAW);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform1f(uniforms.instanced, 0);
      gl.drawArrays(gl.LINES, 0, gridLines.length / 10);
      renderOrder.push('grid-lines');
      ogStageOrder.push('box-grid');
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
    }
    const drawInstances = (drawList, alpha, meshBuffer = sphereBuffer, meshVertexCount = sphereVertexCount, offsetBytes = 0, batchReady = false, instanceCount = drawList.length / 12) => {
      if (!instanceCount || !instancing) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
      gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 6 * 4, 0);
      gl.disableVertexAttribArray(attributes.vertexAlpha);
      gl.vertexAttrib1f(attributes.vertexAlpha, 1);
      gl.uniform1f(uniforms.vertexAlphaEnabled, 0);
      gl.enableVertexAttribArray(attributes.normal);
      gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 6 * 4, 3 * 4);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      if (!batchReady) gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(instanceBuffer, drawList), gl.DYNAMIC_DRAW);
      const instanceStride = 12 * 4;
      gl.enableVertexAttribArray(attributes.instanceCenter);
      gl.vertexAttribPointer(attributes.instanceCenter, 3, gl.FLOAT, false, instanceStride, offsetBytes);
      gl.enableVertexAttribArray(attributes.instanceRadius);
      gl.vertexAttribPointer(attributes.instanceRadius, 1, gl.FLOAT, false, instanceStride, offsetBytes + 3 * 4);
      gl.enableVertexAttribArray(attributes.color);
      gl.vertexAttribPointer(attributes.color, 3, gl.FLOAT, false, instanceStride, offsetBytes + 4 * 4);
      gl.enableVertexAttribArray(attributes.instanceAxis);
      gl.vertexAttribPointer(attributes.instanceAxis, 3, gl.FLOAT, false, instanceStride, offsetBytes + 7 * 4);
      gl.enableVertexAttribArray(attributes.instanceElongation);
      gl.vertexAttribPointer(attributes.instanceElongation, 1, gl.FLOAT, false, instanceStride, offsetBytes + 10 * 4);
      gl.enableVertexAttribArray(attributes.instanceAlpha);
      gl.vertexAttribPointer(attributes.instanceAlpha, 1, gl.FLOAT, false, instanceStride, offsetBytes + 11 * 4);
      instancing.vertexAttribDivisorANGLE(attributes.instanceCenter, 1);
      instancing.vertexAttribDivisorANGLE(attributes.instanceRadius, 1);
      instancing.vertexAttribDivisorANGLE(attributes.color, 1);
      instancing.vertexAttribDivisorANGLE(attributes.instanceAxis, 1);
      instancing.vertexAttribDivisorANGLE(attributes.instanceElongation, 1);
      instancing.vertexAttribDivisorANGLE(attributes.instanceAlpha, 1);
      gl.uniform1f(uniforms.instanced, 1);
      gl.uniform1f(uniforms.drawAlpha, alpha);
      instancing.drawArraysInstancedANGLE(gl.TRIANGLES, 0, meshVertexCount, instanceCount);
      instanceDrawCalls++;
      instancing.vertexAttribDivisorANGLE(attributes.instanceCenter, 0);
      instancing.vertexAttribDivisorANGLE(attributes.instanceRadius, 0);
      instancing.vertexAttribDivisorANGLE(attributes.color, 0);
      instancing.vertexAttribDivisorANGLE(attributes.instanceAxis, 0);
      instancing.vertexAttribDivisorANGLE(attributes.instanceElongation, 0);
      instancing.vertexAttribDivisorANGLE(attributes.instanceAlpha, 0);
      for (const name of ['instanceCenter', 'instanceRadius', 'instanceAxis', 'instanceElongation', 'instanceAlpha']) gl.disableVertexAttribArray(attributes[name]);
      gl.vertexAttrib3f(attributes.instanceCenter, 0, 0, 0);
      gl.vertexAttrib1f(attributes.instanceRadius, 1);
      gl.vertexAttrib3f(attributes.instanceAxis, 1, 0, 0);
      gl.vertexAttrib1f(attributes.instanceElongation, 1);
      gl.vertexAttrib1f(attributes.instanceAlpha, 1);
    };
    let instanceDrawCalls = 0;
    let arrowDrawCalls = 0;
    const drawArrowGeometry = geometry => {
      if (!geometry) return;
      for (const name of ['instanceCenter', 'instanceRadius', 'instanceAxis', 'instanceElongation', 'instanceAlpha']) gl.disableVertexAttribArray(attributes[name]);
      gl.vertexAttrib3f(attributes.instanceCenter, 0, 0, 0);
      gl.vertexAttrib1f(attributes.instanceRadius, 1);
      gl.vertexAttrib3f(attributes.instanceAxis, 1, 0, 0);
      gl.vertexAttrib1f(attributes.instanceElongation, 1);
      gl.vertexAttrib1f(attributes.instanceAlpha, 1);
      gl.uniform1f(uniforms.instanced, 0);
      gl.uniform1f(uniforms.drawAlpha, 1);
      if (geometry.surface.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(buffer, geometry.surface), gl.DYNAMIC_DRAW);
        for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
          gl.enableVertexAttribArray(attributes[name]);
          gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
        }
        gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
        gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
        gl.drawArrays(gl.TRIANGLES, 0, geometry.surface.length / 10);
      }
      if (geometry.outline.length) {
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(lineBuffer, geometry.outline), gl.DYNAMIC_DRAW);
        for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
          gl.enableVertexAttribArray(attributes[name]);
          gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
        }
        gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
        gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
        gl.drawArrays(gl.LINES, 0, geometry.outline.length / 10);
      }
      arrowDrawCalls++;
    };
    if (!orderedRendering) {
      drawInstances(cursorDrawInstances, 1, cursorSphereBuffer, cursorSphereVertexCount);
      if (cursorFallbackVertices.length) drawRawGeometry(cursorFallbackVertices);
      if (cursorDrawInstances.length || cursorFallbackVertices.length) renderOrder.push('cursor');
    }
    if (orderedRendering) {
      const orderedGlErrors = drawOrderedSurfaces();
      lastOrderedGlErrors = orderedGlErrors;
      for (const item of orderedDraws) transparentDrawOrder.push({ id: item.nodeId, layer: item.layer });
      renderOrder.push('node-geometry-by-id');
      if (cursorDrawInstances.length) renderOrder.push('cursor');
      ogStageOrder.push('node-loop');
    } else if (instancing) {
      drawRawGeometry(vertices, cylinderLines);
      drawInstances(instances, 1);
      if (vertices.length || instances.length) renderOrder.push('nodes');
      ogStageOrder.push('node-loop');
    } else {
      drawRawGeometry(vertices, cylinderLines);
      if (arrowVertices.length) drawRawGeometry(arrowVertices, arrowLines);
      if (vertices.length || arrowVertices.length) renderOrder.push('nodes-and-arrows');
      ogStageOrder.push('node-loop');
    }
    if (transparentFallbackVertices.length && !orderedRendering) {
      gl.bindBuffer(gl.ARRAY_BUFFER, transparentFallbackBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(transparentFallbackBuffer, transparentFallbackVertices), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(attributes.position);
      gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(attributes.normal);
      gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);
      gl.enableVertexAttribArray(attributes.color);
      gl.vertexAttribPointer(attributes.color, 3, gl.FLOAT, false, stride, 6 * Float32Array.BYTES_PER_ELEMENT);
      gl.enableVertexAttribArray(attributes.vertexAlpha);
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform1f(uniforms.instanced, 0);
      gl.uniform1f(uniforms.drawAlpha, 0.25);
      gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, transparentFallbackVertices.length / 10);
      gl.disable(gl.BLEND);
      renderOrder.push('transparent-spheres-fallback');
    }
    if (overlayLines.length) {
      for (const name of ['instanceCenter', 'instanceRadius', 'instanceAxis', 'instanceElongation', 'instanceAlpha']) gl.disableVertexAttribArray(attributes[name]);
      gl.vertexAttrib3f(attributes.instanceCenter, 0, 0, 0);
      gl.vertexAttrib1f(attributes.instanceRadius, 1);
      gl.vertexAttrib3f(attributes.instanceAxis, 1, 0, 0);
      gl.vertexAttrib1f(attributes.instanceElongation, 1);
      gl.vertexAttrib1f(attributes.instanceAlpha, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(overlayBuffer, overlayLines), gl.DYNAMIC_DRAW);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT);
      }
      gl.enableVertexAttribArray(attributes.vertexAlpha);
      gl.uniform1f(uniforms.instanced, 0);
      gl.uniform1f(uniforms.drawAlpha, 1);
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * Float32Array.BYTES_PER_ELEMENT);
      gl.uniform1f(uniforms.vertexAlphaEnabled, 1);
      gl.drawArrays(gl.LINES, 0, overlayLines.length / 10);
      renderOrder.push('late-lines');
      ogStageOrder.push('connections');
    }
    if (sliceVertices.length) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, uploadScratch(buffer, sliceVertices), gl.DYNAMIC_DRAW);
      for (const [name, size, offset] of [['position', 3, 0], ['normal', 3, 3], ['color', 3, 6]]) {
        gl.enableVertexAttribArray(attributes[name]);
        gl.vertexAttribPointer(attributes[name], size, gl.FLOAT, false, stride, offset * 4);
      }
      gl.vertexAttribPointer(attributes.vertexAlpha, 1, gl.FLOAT, false, stride, 9 * 4);
      gl.uniform1f(uniforms.instanced, 0);
      gl.drawArrays(gl.POINTS, 0, sliceVertices.length / 10);
      renderOrder.push('slice-plots');
      ogStageOrder.push('slice-plots');
    }
    drawInstances(centroidDrawInstances, 1);
    if (centroidFallbackVertices.length) drawRawGeometry(centroidFallbackVertices);
    if (centroidDrawInstances.length) renderOrder.push('centroids');
    if (centroidDrawInstances.length || centroidFallbackVertices.length) ogStageOrder.push('cell-centroids');
    window.embryomakerRenderer.lastFrame = {
      serial: ++renderSerial,
      visibleNodes: visible.length,
      eggshellTriangles: shellTriangleCount,
      eggshellMeshTriangles: shell?.triangles?.length || 0,
      showEggshell: Boolean(options.showEggshell),
      slicePlotPoints: sliceVertices.length / 10,
      colorField: options.colorField,
      colorRangeField: options.colorRangeField,
      colorRange: options.colorRange,
      nodeColorSamples: visible.slice(0, 3).map(nodeRgb),
      fixedSections: Boolean(options.fixedSections),
      sceneBounds: options.bounds ? [options.bounds.minx, options.bounds.maxx, options.bounds.miny, options.bounds.maxy, options.bounds.minz, options.bounds.maxz] : null,
      displayBounds: (options.sectionBounds || options.bounds) ? [(options.sectionBounds || options.bounds).minx, (options.sectionBounds || options.bounds).maxx, (options.sectionBounds || options.bounds).miny, (options.sectionBounds || options.bounds).maxy, (options.sectionBounds || options.bounds).minz, (options.sectionBounds || options.bounds).maxz] : null,
      sphereInstances: instancing ? instances.length / 12 : 0,
      ellipticalInstances,
      transparentSphereCount,
      transparentRadii,
      transparentDisplayRadii,
      transparentDrawOrder: captureOverlayOrder ? transparentDrawOrder.slice(0, 128) : [],
      transparentDrawOrderTruncated: captureOverlayOrder ? Math.max(0, transparentDrawOrder.length - 128) : 0,
      orderedPrimitiveOrder: captureOverlayOrder ? orderedCommands.slice(0, 128).map(({ nodeId, layer, mode, first, count }) => ({ id: nodeId, layer, mode, first, count })) : [],
      orderedPrimitiveOrderTruncated: captureOverlayOrder ? Math.max(0, orderedCommands.length - 128) : 0,
      nodeLoopOrder: nodeLoopOrder.slice(0, 128),
      nodeLoopOrderTruncated: Math.max(0, nodeLoopOrder.length - 128),
      transparentFallbackVertexCount: transparentFallbackVertices.length / 10,
      transparentSphereSlices: 10,
      transparentSphereStacks: 30,
      sphereSlices: 10,
      sphereStacks: 10,
      spherePolarAxis: 'z',
      // Second longitude sample from the first ring, used to guard the OG
      // sphere orientation measured in paired renderer captures.
      sphereAzimuthSample: sphereMesh.slice(12, 15),
      cursorSphereSlices: 4,
      centroidInstances,
      centroidDisplayRadius: centroidInstances ? 0.01 : null,
      cursorInstances,
      cursorRadius: options.cursor?.enabled ? 0.3 : null,
      cursorPosition: options.cursor?.enabled ? [options.cursor.x, options.cursor.y, options.cursor.z] : null,
      arrowCount,
      arrowVectors,
      movementVectors,
      arrowField: options.arrowField,
      arrowRange: options.arrowRange,
      arrowScale: options.arrowScale ?? 1,
      arrowColorCompensation: ARROW_COLOR_COMPENSATION,
      showArrows: Boolean(options.showArrows),
      sphereField: options.sphereField,
      transparentRange: options.transparentRange,
      transparentScale: options.transparentScale ?? 1,
      showTransparentSpheres: Boolean(options.showTransparentSpheres),
      overlayLineVertices: overlayLines.length / 10,
      underlayLineVertices: underlayLines.length / 10,
      underlayLineSamples: Array.from({ length: Math.min(underlayLines.length / 20, 4) }, (_, index) => [underlayLines.slice(index * 20, index * 20 + 3), underlayLines.slice(index * 20 + 10, index * 20 + 13)]),
      gridLineVertices: gridLines.length / 10,
      arrowTriangleVertices: arrowVertices.length / 10,
      arrowOutlineVertices: arrowLines.length / 10,
      cylinderCapNormalSample: [...nodeGeometryById.values()].find(geometry => geometry.kind === 'cylinder')?.surface.slice(3, 6) || null,
      arrowCapNormalSample: [...arrowGeometryByNode.values()][0]?.surface.slice(3, 6) || null,
      renderOrder,
      ogPipelineOrder: OG_RENDER_STAGE_ORDER,
      ogStageOrder,
      triangleVertices: vertices.length / 10,
      lineVertices: cylinderLines.length / 10,
      cameraDistance: cameraDistance / options.zoom,
      cameraYaw: options.yaw,
      cameraPitch: options.pitch,
      zoom: options.zoom,
      panX: options.panX,
      panY: options.panY,
      displayBox: Boolean(options.showBox),
      showEllipses: Boolean(options.showEllipses),
      radiusMode: options.radiusMode,
      drawCalls: (orderedRendering ? orderedCommands.filter(command => command.mode !== 'instances').length : Number(Boolean(vertices.length)) + Number(Boolean(cylinderLines.length)) + Number(Boolean(arrowVertices.length)) * Math.max(1, arrowDrawCalls) + instanceDrawCalls) + Number(Boolean(gridLines.length)) + Number(Boolean(transparentFallbackVertices.length)) + Number(Boolean(cursorFallbackVertices.length)) + Number(Boolean(centroidFallbackVertices.length)) + Number(Boolean(overlayLines.length)) + Number(Boolean(underlayLines.length)) + instanceDrawCalls,
      gpuRenderer,
      orderedGlErrors: lastOrderedGlErrors,
      antialias: gl.getContextAttributes().antialias,
      canvasAlpha: gl.getContextAttributes().alpha,
      glError: gl.getError()
    };
    return visible.length;
  }
  window.embryomakerRenderer = { active: true, render, lastFrame: null };
})();
