program single_division_reference
use general
use inicial
use single_node
implicit none
integer :: cell_id, node_id, first_new
character*200 :: input_file

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
if (len_trim(input_file)==0) stop 10
call initials
cell_id=1
do while(cell_id<=ncels)
  if(node(cels(cell_id)%node(1))%fix==0) exit
  cell_id=cell_id+1
end do
if(cell_id>ncels) stop 11
delta=1.0d0
ffu(18)=1
ffu(25)=1
npag(nparam_per_node+2)=1
whonpag(nparam_per_node+2,1)=1
gen(1)%e(nparam_per_node+2)=1.0d8
do node_id=1,nd
  gex(node_id,1)=0.0d0
end do
gex(cels(cell_id)%node(1),1)=1.0d0
cels(cell_id)%fase=0.0d0
call should_I_divide_single
first_new=nd
if(cels(cell_id)%ctipus<3) first_new=nd-1
write(*,'(I0,1X,I0,1X,I0,1X,I0)') nd,ncels,cell_id,first_new
do node_id=first_new,nd
  write(*,'(I0,1X,I0,1X,I0,1X,I0,1X,I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
    node_id,node(node_id)%tipus,node(node_id)%icel,node(node_id)%altre,node(node_id)%marge,node(node_id)%ndiv,node(node_id)%x,node(node_id)%y,node(node_id)%z,node(node_id)%add,node(node_id)%eqd
end do
write(*,'(I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
  cell_id,cels(cell_id)%nunodes,cels(cell_id)%fase,cels(cell_id)%cex,cels(cell_id)%cey,cels(cell_id)%cez
do node_id=1,cels(cell_id)%nunodes
  write(*,'(1X,I0)',advance='no') cels(cell_id)%node(node_id)
end do
write(*,*)
write(*,'(I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
  ncels,cels(ncels)%nunodes,cels(ncels)%fase,cels(ncels)%cex,cels(ncels)%cey,cels(ncels)%cez
do node_id=1,cels(ncels)%nunodes
  write(*,'(1X,I0)',advance='no') cels(ncels)%node(node_id)
end do
write(*,*)
end program single_division_reference
