/* Opt-in 2D vector-field research model, independent of the cell solver.
 * Open-boundary Berg-Luscher charge with oriented geodesic triangles.
 * Educational damped gradient relaxation, NOT calibrated Landau-Lifshitz dynamics.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TopologyCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const TAU = Math.PI * 2;
  function normalize(v, i) {
    const length = Math.hypot(v[i], v[i + 1], v[i + 2]);
    if (!(length > 1e-12)) throw Error('spin vector must have nonzero length');
    v[i] /= length; v[i + 1] /= length; v[i + 2] /= length;
  }
  function seed(size = 81, kind = 'neel', radius = 0.45, wall = 0.08) {
    if (!Number.isInteger(size) || size < 5 || !(radius > 0 && radius < 1) || !(wall > 0)) {
      throw Error('size >= 5, 0 < radius < 1, wall > 0 required');
    }
    if (!['neel', 'bloch', 'uniform', 'antiskyrmion'].includes(kind)) throw Error('invalid texture');
    const out = new Float64Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = 3 * (y * size + x);
      if (kind === 'uniform') { out[i + 2] = 1; continue; }
      const xx = x * 2 / (size - 1) - 1, yy = y * 2 / (size - 1) - 1;
      const r = Math.hypot(xx, yy);
      const theta = 2 * Math.atan(Math.exp(Math.max(-80, Math.min(80, (radius - r) / wall))));
      const phi = (kind === 'antiskyrmion' ? -1 : 1) * Math.atan2(yy, xx) + (kind === 'bloch' ? Math.PI / 2 : 0);
      out[i] = Math.sin(theta) * Math.cos(phi);
      out[i + 1] = Math.sin(theta) * Math.sin(phi);
      out[i + 2] = Math.cos(theta);
      normalize(out, i);
    }
    return out;
  }
  function angle(f, ai, bi, ci) {
    const ax=f[ai], ay=f[ai+1], az=f[ai+2];
    const bx=f[bi], by=f[bi+1], bz=f[bi+2];
    const cx=f[ci], cy=f[ci+1], cz=f[ci+2];
    const cross = ax*(by*cz-bz*cy) + ay*(bz*cx-bx*cz) + az*(bx*cy-by*cx);
    const denominator = 1 + ax*bx+ay*by+az*bz + bx*cx+by*cy+bz*cz + cx*ax+cy*ay+cz*az;
    return 2 * Math.atan2(cross, denominator);
  }
  function charge(field, size) {
    if (field.length !== size*size*3 || size < 2) throw Error('invalid field shape');
    let sum=0;
    for (let y=0; y<size-1; y++) for(let x=0;x<size-1;x++){
      const a=3*(y*size+x), b=a+3, d=a+3*size, c=d+3;
      sum += angle(field,a,b,c)+angle(field,a,c,d);
    }
    return sum/(2*TAU);
  }
  function perturb(field, amount = 0.1, randomSeed = 12345) {
    if (!(amount >= 0 && Number.isFinite(amount))) throw Error('invalid noise');
    const out=field.slice(); let state=randomSeed|0;
    const random=()=>{state ^= state << 13;state ^= state >>> 17;state ^= state << 5;return (state>>>0)/4294967296;};
    for(let i=0;i<out.length;i+=3){
      for(let k=0;k<3;k++)out[i+k]+=amount*(random()*2-1);
      normalize(out,i);
    }
    return out;
  }
  function relax(field,size,{exchange=0.35,dmi=0.12,anisotropy=0.08,dt=0.12}={}) {
    if (field.length !== size*size*3 || size < 3) throw Error('invalid field shape');
    if (![exchange,dmi,anisotropy,dt].every(Number.isFinite) || dt <= 0) throw Error('invalid coefficients');
    const out=field.slice();
    const index=(x,y)=>3*(y*size+x);
    for(let y=1;y<size-1;y++)for(let x=1;x<size-1;x++){
      const i=index(x,y),l=index(x-1,y),r=index(x+1,y),u=index(x,y-1),d=index(x,y+1);
      const hx=exchange*(field[l]+field[r]+field[u]+field[d]-4*field[i])
        +dmi*(field[r+2]-field[l+2])*0.5;
      const hy=exchange*(field[l+1]+field[r+1]+field[u+1]+field[d+1]-4*field[i+1])
        +dmi*(field[d+2]-field[u+2])*0.5;
      const hz=exchange*(field[l+2]+field[r+2]+field[u+2]+field[d+2]-4*field[i+2])
        -dmi*((field[r]-field[l]+field[d+1]-field[u+1])*0.5)
        +anisotropy*field[i+2];
      const dot=field[i]*hx+field[i+1]*hy+field[i+2]*hz;
      out[i]=field[i]+dt*(hx-dot*field[i]);
      out[i+1]=field[i+1]+dt*(hy-dot*field[i+1]);
      out[i+2]=field[i+2]+dt*(hz-dot*field[i+2]);
      normalize(out,i);
    }
    return out;
  }
  function gradientEnergy(field,size) {
    let sum=0;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const i=3*(y*size+x);
      for(const j of [x+1<size?i+3:-1,y+1<size?i+3*size:-1]){
        if(j<0)continue;
        for(let k=0;k<3;k++){const d=field[i+k]-field[j+k];sum+=d*d;}
      }
    }
    return sum/2;
  }
  return {seed,charge,perturb,relax,gradientEnergy};
});
