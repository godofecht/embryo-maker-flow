program model_prepare_reference
use general
use inicial
implicit none
integer :: cell_id, slot, node_id
real*8 :: sum_x, sum_y, sum_z, inverse_count, largest_radius
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
  sum_x=0.0d0
  sum_y=0.0d0
  sum_z=0.0d0
  do slot=1,cels(cell_id)%nunodes
    node_id=cels(cell_id)%node(slot)
    if(node(node_id)%tipus==1.or.node(node_id)%tipus==3)then
      sum_x=sum_x+node(node_id)%x
      sum_y=sum_y+node(node_id)%y
      sum_z=sum_z+node(node_id)%z
    endif
  end do
  inverse_count=1.0d0/real(cels(cell_id)%nunodes)
  if(node(cels(cell_id)%node(1))%tipus<3) inverse_count=2.0d0*inverse_count
  cels(cell_id)%cex=sum_x*inverse_count
  cels(cell_id)%cey=sum_y*inverse_count
  cels(cell_id)%cez=sum_z*inverse_count
end do
largest_radius=maxval(node(1:nd)%add)
rdiffmax=2.0d0*largest_radius*dmax
write(*,'(I0,1X,ES25.16E3)') ncels,rdiffmax
do cell_id=1,ncels
  write(*,'(I0,1X,ES25.16E3,1X,ES25.16E3,1X,ES25.16E3)') cell_id,cels(cell_id)%cex,cels(cell_id)%cey,cels(cell_id)%cez
end do
end program model_prepare_reference
