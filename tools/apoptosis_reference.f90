program apoptosis_reference
use general
use inicial
use automaticon
use death
implicit none
integer :: cell_id, slot, node_id
character*200 :: input_file
character*20 :: operation

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
operation="apoptosis"
call getarg(2,operation)
call no_config_file
call initials
node_id=cels(1)%node(1)
if (trim(operation)=="death") then
  call should_I_die
else
  call apoptosis(node_id)
end if
write(*,'(I0,1X,I0)') nd,ncels
do slot=1,nd
  write(*,'(I0,1X,I0,1X,I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
    slot,node(slot)%tipus,node(slot)%icel,node(slot)%altre,node(slot)%x,node(slot)%y,node(slot)%z,node(slot)%grd
end do
do cell_id=1,ncels
  write(*,'(I0,1X,I0)',advance='no') cell_id,cels(cell_id)%nunodes
  do slot=1,cels(cell_id)%nunodes
    write(*,'(1X,I0)',advance='no') cels(cell_id)%node(slot)
  end do
  write(*,*)
end do
end program apoptosis_reference
