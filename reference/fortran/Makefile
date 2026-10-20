# Builds the original EmbryoMaker core without OpenGL, for reference runs.
FC = gfortran
FFLAGS = -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy
SRC = src
BUILD = build

MODS = aleas.mod.f90 general.mod.f90 geompack3.f90 gnuplotter.mod.f90 \
       shell.mod.f90 neighboring.mod.f90 genetic.mod.f90 energy.mod.f90 \
       io.mod.f90 polarization.mod.f90 biomechanic_pola.mod.f90 \
       biomechanic.mod.f90 death.mod.f90 pola.mod.f90 ecm.mod.f90 \
       growth.mod.f90 ic.mod.f90 mitosis.mod.f90 single_node.mod.f90 \
       nexus.mod.f03 inicial.mod.f90 model.mod.f90 automaticon.mod.f90 \
       headless.f90

GUI_MODS = OpenGL_gl.f90 OpenGL_glu.f90 OpenGL_glut.f90 \
           $(filter-out headless.f90,$(MODS)) editor.mod.f90 drawer.mod.f90 elli.f90

all: $(BUILD)/emaker_ref

gui:
	mkdir -p $(BUILD)/gui
	cd $(BUILD)/gui && for f in $(GUI_MODS); do $(FC) $(FFLAGS) -c ../../$(SRC)/$$f || exit 1; done
	cd $(BUILD)/gui && $(FC) $(FFLAGS) -o ../emaker_gui *.o -framework GLUT -framework OpenGL

$(BUILD)/emaker_ref: $(addprefix $(SRC)/,$(MODS))
	mkdir -p $(BUILD)
	cd $(BUILD) && for f in $(MODS); do $(FC) $(FFLAGS) -c ../$(SRC)/$$f || exit 1; done
	cd $(BUILD) && $(FC) $(FFLAGS) -o emaker_ref *.o

clean:
	rm -rf $(BUILD)

.PHONY: all gui clean
