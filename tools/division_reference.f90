program division_reference
use general
use inicial
use mitosis
implicit none
integer :: cell_id, node_id, slot
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
  if (node(cels(cell_id)%node(1))%fix==0.and.cels(cell_id)%nunodes>=4) exit
  cell_id=cell_id+1
end do
if (cell_id>ncels) stop 11
delta=1.0d0
npag(nparam_per_node+2)=1
whonpag(nparam_per_node+2,1)=1
gen(1)%e(nparam_per_node+2)=1.0d8
do node_id=1,nd
  gex(node_id,1)=0.0d0
end do
gex(cels(cell_id)%node(1),1)=1.0d0
cels(cell_id)%minsize_for_div=1.0d0
cels(cell_id)%fase=0.0d0
call should_I_divide
write(*,'(I0,1X,I0)') nd,ncels
do node_id=1,nd
  write(*,'(I0,1X,I0,1X,I0,1X,I0,1X,I0,1X,I0)') node_id,node(node_id)%tipus,node(node_id)%icel,node(node_id)%altre,node(node_id)%marge,node(node_id)%fix
end do
do cell_id=1,ncels
  write(*,'(I0,1X,I0,1X,I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') &
    cell_id,cels(cell_id)%nunodes,cels(cell_id)%ctipus,cels(cell_id)%cex,cels(cell_id)%cey,cels(cell_id)%cez,cels(cell_id)%fase,cels(cell_id)%minsize_for_div,cels(cell_id)%maxsize_for_div,cels(cell_id)%polx,cels(cell_id)%poly,cels(cell_id)%polz
  do slot=1,cels(cell_id)%nunodes
    write(*,'(1X,I0)',advance='no') cels(cell_id)%node(slot)
  end do
  write(*,*)
end do
end program division_reference
