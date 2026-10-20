program movement_reference
use general
use inicial
use automaticon
use biomechanic
implicit none
integer :: node_id
character*200 :: input_file, mode

call random_seed(size=nseed)
if (allocated(idum)) deallocate(idum)
allocate(idum(nseed))
if (allocated(idumoriginal)) deallocate(idumoriginal)
allocate(idumoriginal(nseed))
whichend=0
aut=0
eva=0
call getarg(1,input_file)
call getarg(2,mode)
if (len_trim(input_file)==0) stop 10
call no_config_file
call initials
call iterdiferencial
if (trim(mode)=="rk4") then
  call rungekutta4(delta)
else
  call adaptive_rungekutta
end if

do node_id=1,nd
  write(*,'(I0,3(1X,ES25.16E3))') node_id,node(node_id)%x,node(node_id)%y,node(node_id)%z
end do
end program movement_reference
