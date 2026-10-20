program division_phase_reference
use general
use inicial
use automaticon
use nexus
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
do cell_id=1,ncels
  cels(cell_id)%minsize_for_div=1.0d9
  cels(cell_id)%maxsize_for_div=1.0d9
end do
call should_I_divide

write(*,'(I0)') ncels
do cell_id=1,ncels
  write(*,'(I0,1X,ES25.16E3)') cell_id,cels(cell_id)%fase
end do
end program division_phase_reference
