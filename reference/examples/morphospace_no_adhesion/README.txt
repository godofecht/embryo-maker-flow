MORPHOSPACE FIGURE 7A WITHOUT ADHESION MOLECULES

Question. How much of a morphospace starting state's behaviour is carried by the
adhesion molecules, rather than by the mechanics and the gene network?

This input is reference/examples/morphospace_exploration/Figure_7A.dat with one
global parameter changed:

  row 9  number of adh molecules   2  ->  0

The starting geometry, all 1144 nodes and the 22 genes are unchanged.

Measured with the C backend, 300 iterations, same build for both runs:

  control  1371 nodes, mean displacement 0.0847, max 0.3948
  variant  1371 nodes, mean displacement 0.0943, max 0.2595
  between the two runs: mean 0.1138, max 2.2201

The same number of cells divides in both runs, so proliferation is unaffected,
yet the two end states differ by up to 2.22 units at the widest node. The
adhesion molecules are not holding this state together in the sense of stopping
it from moving; they are steering where it goes.

The same one-row change on the sea urchin starting state leaves the amount of
movement essentially unchanged as well (mean displacement 0.1121 to 0.1129 over
600 iterations, widest separation 0.43), which is the cross-starting-state
contrast worth looking at next.

These are simulator measurements under this model's assumptions. They are not
biological evidence.
