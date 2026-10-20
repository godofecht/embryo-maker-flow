program itera_energy_reference
use general
use inicial
use automaticon
use neighboring
use model
implicit none
character*200 :: input_file, steps_text
integer :: idx
integer :: steps

call random_seed(size=nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))
whichend=0
aut=0
eva=0
call getarg(1,input_file)
call getarg(2,steps_text)
steps=1
if (len_trim(steps_text)>0) read(steps_text,*) steps
if (len_trim(input_file)==0) stop 10
call no_config_file
call initials
ffu(15)=0
ffu(16)=1
call neighbor_build
call restore_neighbors
do idx=1,steps
  call itera
end do
do idx=1,nd
  write(*,'(I0,4(1X,ES25.16E3))') idx,node(idx)%x,node(idx)%y,node(idx)%z,node(idx)%e
end do
end program itera_energy_reference
