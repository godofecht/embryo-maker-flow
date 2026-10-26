SEA URCHIN WITHOUT THE EPITHELIAL DEFORMATION CAP

Question. The sea urchin starting state invaginates its vegetal pole over 2,000
iterations. How much of that movement depends on the epithelium being able to
raise the regulatory molecule without an upper bound?

This input is reference/examples/sea_urchin_gastrulation/sea_urchin.txt with one
global parameter changed:

  row 28  M(DFE)  maximal req value allowed by epithelial deformation
          0.5  ->  0

With the cap at zero, epithelial deformation can no longer add regulatory
molecule, so the accumulation that normally follows deformation is removed while
the mechanics are left untouched.

Measured with the C backend, 600 iterations, same build for both runs:

  control  3629 nodes, 2451 nodes moved, mean displacement 0.1121, max 0.7709
  variant  3629 nodes, 2451 nodes moved, mean displacement 0.0280, max 0.1425
  between the two runs: mean 0.1063, max 0.7483

The same number of nodes still move, but the tissue moves about four times less.
In this simulator the deformation-to-req feedback, not the mechanics alone, is
what carries most of the invagination over this horizon.

These are simulator measurements under this model's assumptions. They are not
biological evidence.
