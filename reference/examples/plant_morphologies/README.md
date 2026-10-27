# Plant forms

The Studio includes four small plant inspired starting forms:

- Auxin stem growth: a straight, seven-cell stem.
- Curved shoot: an auxin supplied stem with a curved axis.
- Forked shoot: a two-tip shoot with auxin supplied at both tips.
- Branched root: a downward axis with two lateral tips.

The three added inputs use the same seven-cell tube model and auxin response as the straight stem. Their segment geometry sets the starting form. Auxin response drives local cell growth during a run. They are compact model demonstrations, not detailed plant anatomy or validated transport models.

Regenerate the inputs with:

```sh
python3 tools/create_auxin_stem_example.py
python3 tools/create_plant_morphologies.py
```
