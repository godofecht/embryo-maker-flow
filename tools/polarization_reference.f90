program polarization_reference
use general
use inicial
use automaticon
use nexus
use genetic
implicit none
integer :: cell_id
character*200 :: input_file

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
if (npag(nparam_per_node+8)>0) call polarization

do cell_id=1,ncels
  write(*,'(I0,3(1X,ES25.16E3))') cell_id,cels(cell_id)%polx,cels(cell_id)%poly,cels(cell_id)%polz
end do
end program polarization_reference
