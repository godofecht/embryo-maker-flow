program diffusion_reference
use general
use inicial
use automaticon
use neighboring
use nexus
implicit none
character*200 :: input_file
integer :: idx

call random_seed(size=nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))
whichend=0
aut=0
eva=0
call getarg(1,input_file)
if (len_trim(input_file)==0) stop 10
call no_config_file
call initials
call neighbor_build
delta=0.02d0
dif_req=0.3d0
do idx=1,nd
  node(idx)%grd=mod(idx,7)*0.125d0
end do
call diffusion_of_reqcr
do idx=1,nd
  write(*,'(I0,1X,ES25.16E3)') idx,node(idx)%grd
end do
end program diffusion_reference
