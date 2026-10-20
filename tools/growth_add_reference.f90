program growth_add_reference
use general
use inicial
use automaticon
use growth
implicit none
integer :: cell_id, slot, node_id, parent_id, paired_id
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
cell_id=1
do while (cell_id<=ncels)
  if (node(cels(cell_id)%node(1))%fix==0) exit
  cell_id=cell_id+1
end do
if (cell_id>ncels) stop 11
parent_id=cels(cell_id)%node(1)
paired_id=node(parent_id)%altre
delta=1.0d0
ffu(1)=1
npag(nparam_per_node+1)=1
whonpag(nparam_per_node+1,1)=1
gen(1)%e(nparam_per_node+1)=1.0d8
npag(nparam_per_node+9)=0
do node_id=1,nd
  gex(node_id,1)=0.0d0
  agex(node_id,1)=0.0d0
end do
gex(parent_id,1)=1.0d0
agex(parent_id,1)=1.0d0
if (paired_id>0) then
  gex(paired_id,1)=1.0d0
  agex(paired_id,1)=1.0d0
end if
call should_I_grow
write(*,'(I0,1X,I0)') nd,ncels
do slot=1,nd
  write(*,'(I0,1X,I0,1X,I0,1X,I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
    slot,node(slot)%tipus,node(slot)%icel,node(slot)%altre,node(slot)%marge,node(slot)%x,node(slot)%y,node(slot)%z,node(slot)%grd,gex(slot,1),agex(slot,1),nodeo(slot)%grd
end do
do cell_id=1,ncels
  write(*,'(I0,1X,I0)',advance='no') cell_id,cels(cell_id)%nunodes
  do slot=1,cels(cell_id)%nunodes
    write(*,'(1X,I0)',advance='no') cels(cell_id)%node(slot)
  end do
  write(*,*)
end do
end program growth_add_reference
