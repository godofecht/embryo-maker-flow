program growth_reference
use general
use inicial
use automaticon
use growth
implicit none
integer :: slot
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
call should_I_grow
write(*,'(I0)') nd
do slot=1,nd
  write(*,'(I0,1X,ES25.16E3,1X,ES25.16E3)') slot,node(slot)%grd,nodeo(slot)%grd
end do
end program growth_reference
