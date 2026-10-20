program ecm_reference
use general
use inicial
use automaticon
use ecm
implicit none
integer :: node_id, gene_id, old_nd
character*200 :: input_file
character*16 :: mode

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
if (trim(mode)=="info") then
  write(*,'(3I8)') ffu(19),npag(nparam_per_node+11),count(node(1:nd)%tipus==3)
  stop
end if
if (trim(mode)=="emit") then
  old_nd=nd
  call ecm_secretion(1)
  write(*,'(I0)') old_nd
  write(*,'(I0,1X,3ES25.16E3,4(1X,ES25.16E3),2(1X,I0))') nd,node(nd)%x,node(nd)%y,node(nd)%z,node(nd)%eqd,node(nd)%grd,node(nd)%add,node(nd)%rec,node(nd)%tipus,node(nd)%icel
  do gene_id=1,ng
    write(*,'(I0,4(1X,ES25.16E3))') gene_id,gex(1,gene_id),agex(1,gene_id),gex(nd,gene_id),agex(nd,gene_id)
  end do
  stop
end if
if (trim(mode)=="trigger") then
  old_nd=nd
  node(1)%ecm=ecmmax
  call should_I_secrete
  write(*,'(I0,1X,I0,1X,ES25.16E3)') old_nd,nd,node(1)%ecm
  if(nd>old_nd) write(*,'(I0,1X,3ES25.16E3)') nd-old_nd,node(nd)%x,node(nd)%y,node(nd)%z
  stop
end if
call should_I_secrete

do node_id=1,nd
  write(*,'(I0,1X,ES25.16E3)') node_id,node(node_id)%ecm
end do
end program ecm_reference
