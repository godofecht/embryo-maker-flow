const assert = require('node:assert/strict');
const {seed,charge,perturb,relax,gradientEnergy} = require('../ui/topology-core.js');

const neel=seed(101,'neel'),bloch=seed(101,'bloch'),anti=seed(101,'antiskyrmion');
assert.ok(Math.abs(charge(neel,101)+1)<0.03,'Neel charge near -1');
assert.ok(Math.abs(charge(bloch,101)+1)<0.03,'Bloch charge near -1');
assert.ok(Math.abs(charge(anti,101)-1)<0.03,'antiskyrmion charge near +1');
assert.ok(Math.abs(charge(seed(41,'uniform'),41))<1e-12,'uniform charge is zero');
for(let i=0;i<neel.length;i+=3)assert.ok(Math.abs(Math.hypot(...neel.slice(i,i+3))-1)<1e-12);
const noisy=perturb(neel,0.03,42);
assert.deepEqual(Array.from(noisy),Array.from(perturb(neel,0.03,42)),'seeded perturbations deterministic');
assert.ok(Math.abs(charge(noisy,101)+1)<0.08,'small noise preserves winding');
let evolving=noisy;
for(let i=0;i<25;i++)evolving=relax(evolving,101);
assert.ok(evolving.every(Number.isFinite),'relaxation finite');
assert.ok(Number.isFinite(gradientEnergy(evolving,101)));
assert.notDeepEqual(Array.from(evolving),Array.from(noisy),'evolution changes the field');
console.log('Topology lab: winding, perturbation, evolution and invariants PASS');
