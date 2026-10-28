const assert=require('node:assert/strict');
const core=require('../ui/nematic-core.js');
const size=81;
for(const [kind, expected] of [['plus-half',0.5],['minus-half',-0.5],['plus-one',1],['uniform',0]]){
  const field=core.seed(size,kind);
  for(const r of [8,17,26,36]){
    const measured=core.winding(field,size,r);
    assert.ok(Math.abs(measured-expected)<1e-10,`${kind} measured ${measured}, expected ${expected}`);
  }
  assert.ok(Number.isFinite(core.alignmentEnergy(field,size)));
}
const first=core.seed(size,'plus-half'),noisy=core.perturb(first,size,0.12,42);
assert.deepEqual(Array.from(noisy),Array.from(core.perturb(first,size,0.12,42)));
assert.ok(Math.abs(core.winding(noisy,size)-.5)<1e-8);
let next=noisy;
for(let i=0;i<25;i++) next=core.relax(next,size);
assert.ok(next.every(Number.isFinite));
assert.notDeepEqual(Array.from(next),Array.from(noisy));
for(let i=0;i<next.length;i+=2)assert.ok(Math.abs(Math.hypot(next[i],next[i+1])-1)<1e-12);
assert.throws(()=>core.seed(80,'uniform'),/odd integer/);
assert.throws(()=>core.winding(first,size,41),/radius/);
console.log('Nematic defect winding, seeded noise and relaxation: PASS');
