program actual_iteration_reference
use general
use inicial
use automaticon
implicit none
character*200 :: input_file
integer :: idx, seedidx
call random_seed(size=nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))
whichend=0
aut=0
eva=0
call getarg(1,input_file)
call no_config_file
call initials
! iteracio(1) advances one unit of simulated time. The iteration count depends on delta.
call iteracio(1)
call random_seed(get=idum)
do seedidx=1,nseed
  write(*,'(I0,1X)',advance='no') idum(seedidx)
end do
write(*,*)
do idx=1,nd
  write(*,'(I0,4(1X,ES25.16E3))') idx,node(idx)%x,node(idx)%y,node(idx)%z,node(idx)%e
end do
end program actual_iteration_reference
