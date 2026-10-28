/* Optional director-field laboratory for tissue/active-nematic topology.
 * Doubled-angle vector (cos 2theta, sin 2theta) respects n equivalent to -n.
 * Isolated from the EmbryoMaker cell solver.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NematicCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function validSize(size) {
    if (!Number.isInteger(size) || size < 9 || size % 2 === 0) {
      throw Error('size must be an odd integer >= 9');
    }
  }
  function normalize(field, i) {
    const norm = Math.hypot(field[i], field[i + 1]);
    if (norm <= 1e-12) throw Error('director must have nonzero norm');
    field[i] /= norm;
    field[i + 1] /= norm;
  }
  function seed(size = 81, defect = 'plus-half') {
    validSize(size);
    const windings = {'plus-half': 1, 'minus-half': -1, 'plus-one': 2, uniform: 0};
    if (!Object.hasOwn(windings, defect)) throw Error('invalid nematic defect');
    const m = windings[defect], center = (size - 1) / 2;
    const field = new Float64Array(2 * size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const phi = m * Math.atan2(y - center, x - center);
      const i = 2 * (y * size + x);
      field[i] = Math.cos(phi);
      field[i + 1] = Math.sin(phi);
    }
    return field;
  }
  function loop(size, radius) {
    validSize(size);
    const center = (size - 1) / 2;
    if (!Number.isInteger(radius) || radius < 1 || radius >= center) {
      throw Error('loop radius must lie inside the field');
    }
    const c = center, r = radius, points = [];
    for (let x = c - r; x <= c + r; x++) points.push(c - r, x);
    for (let y = c - r + 1; y <= c + r; y++) points.push(y, c + r);
    for (let x = c + r - 1; x >= c - r; x--) points.push(c + r, x);
    for (let y = c + r - 1; y > c - r; y--) points.push(y, c - r);
    return points;
  }
  function winding(field, size, radius = Math.floor(size / 3)) {
    if (field.length !== 2 * size * size) throw Error('field must hold 2 components per site');
    const points = loop(size, radius);
    const angles = [];
    for (let j = 0; j < points.length; j += 2) {
      const index = 2 * (points[j] * size + points[j + 1]);
      if (!Number.isFinite(field[index]) || !Number.isFinite(field[index + 1])) {
        throw Error('director must be finite');
      }
      angles.push(Math.atan2(field[index + 1], field[index]));
    }
    let total = 0;
    for (let j = 0; j < angles.length; j++) {
      const delta = angles[(j + 1) % angles.length] - angles[j];
      total += Math.atan2(Math.sin(delta), Math.cos(delta));
    }
    return total / (4 * Math.PI);
  }
  function perturb(field, size, amount = 0.2, randomSeed = 12345) {
    if (field.length !== 2 * size * size || !Number.isFinite(amount) || amount < 0) {
      throw Error('invalid field or noise amount');
    }
    const out = field.slice();
    let state = randomSeed | 0;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
    for (let i = 0; i < out.length; i += 2) {
      const angle = (2 * random() - 1) * amount;
      const cs = Math.cos(angle), sn = Math.sin(angle);
      const x = field[i], y = field[i + 1];
      out[i] = cs * x - sn * y;
      out[i + 1] = sn * x + cs * y;
      normalize(out, i);
    }
    return out;
  }
  function relax(field, size, rate = 0.12) {
    if (field.length !== 2 * size * size || !Number.isFinite(rate) || rate <= 0 || rate > 0.25) {
      throw Error('invalid field or relaxation rate');
    }
    const out = field.slice();
    for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
      const i = 2 * (y * size + x), left = i - 2, right = i + 2;
      const up = i - 2 * size, down = i + 2 * size;
      for (let k = 0; k < 2; k++) {
        out[i + k] = field[i + k] + rate * (
          field[left + k] + field[right + k] +
          field[up + k] + field[down + k] - 4 * field[i + k]
        );
      }
      normalize(out, i);
    }
    return out;
  }
  function alignmentEnergy(field, size) {
    if (field.length !== 2 * size * size) throw Error('invalid field size');
    let sum = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = 2 * (y * size + x);
      const compare = j => {
        const dx = field[i] - field[j], dy = field[i + 1] - field[j + 1];
        sum += (dx * dx + dy * dy) / 2;
      };
      if (x + 1 < size) compare(i + 2);
      if (y + 1 < size) compare(i + 2 * size);
    }
    return sum;
  }
  return {seed, winding, perturb, relax, alignmentEnergy};
});
