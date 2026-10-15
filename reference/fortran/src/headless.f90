! Headless EmbryoMaker driver for producing reference outputs.
! It follows the aut=1 path of elli.f90 with the OpenGL setup and the
! cksum/date shell calls removed. Usage matches EMaker:
!   emaker_ref <input.txt> 1 <iterations_per_snapshot> <snapshots>
program headless
use general
use inicial
use automaticon
implicit none
character*80 cu
integer ios

call random_seed(size = nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))

call cpu_time(start_time)
whichend = 0
aut = 1
call getarg(2, cu)
if (len_trim(cu) > 0) read (cu, *) aut
eva = 0
if (aut == 5) eva = 1

precaa = "headless"
caa = "headless_run_"

open(1, file="config_file.txt", status="old", iostat=ios)
if (ios == 0) then
  close(1)
  call read_config_file
else
  call no_config_file
end if

call initials
print *, nd, "nd"
call auto
end program headless
