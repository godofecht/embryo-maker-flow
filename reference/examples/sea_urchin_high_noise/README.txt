SEA URCHIN WITH A HUNDREDFOLD HIGHER TEMPERATURE

Question. Is the gastrulation trajectory robust to thermal fluctuation, or does
the shape depend on the noise being small?

This input is reference/examples/sea_urchin_gastrulation/sea_urchin.txt with one
global parameter changed:

  row 2  M(TEM)  temperature or 1/temperature   0.01  ->  1

Every other parameter, all 3534 starting nodes and every gene value are
identical to the sea urchin example, so the comparison isolates the noise term.

Measured with the C backend, 600 iterations, same build for both runs:

  control  3629 nodes, 2451 nodes moved, mean displacement 0.1121, max 0.7709
  variant  3629 nodes, 2451 nodes moved, mean displacement 0.1130, max 0.8052
  between the two runs: mean 0.0191, max 0.4207

The aggregate movement is unchanged, to within one percent, while individual
nodes end up as much as 0.42 units apart. Over this horizon the amount of
morphogenesis is robust to the noise level; the route to the final shape is not.

These are simulator measurements under this model's assumptions. They are not
biological evidence.
