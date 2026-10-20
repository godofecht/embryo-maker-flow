program single_polarization_reference
use general
use inicial
use single_node
use genetic
use neighboring
implicit none
integer :: node_id
integer :: mode
character*200 :: input_file,mode_arg

call random_seed(size=nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))
whichend=0
aut=0
eva=0
call no_config_file
call getarg(1,input_file)
call getarg(2,mode_arg)
if (len_trim(input_file)==0) stop 10
call initials
read(mode_arg,*) mode
ffu(1)=0
ffu(9)=mode
npag(nparam_per_node+8)=1
whonpag(nparam_per_node+8,1)=1
gen(1)%e(nparam_per_node+8)=0.75d0
do node_id=1,nd
  gex(node_id,1)=1.0d0+0.2d0*node(node_id)%x+0.1d0*node(node_id)%y+0.05d0*node(node_id)%z
end do
call neighbor_build
call polarization_single
do node_id=1,ncels
  write(*,'(I0,1X,3(ES25.16E3,1X))') node_id,cels(node_id)%polx,cels(node_id)%poly,cels(node_id)%polz
end do
end program single_polarization_reference
