program neighbor_mode_reference
use general
use inicial
use neighboring
implicit none
integer :: node_id, slot, gabriel
integer :: rebuild_node
character*200 :: input_file
character*30 :: mode

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
rebuild_node=0
if (len_trim(input_file)==0) stop 10
call no_config_file
call initials
if (trim(mode)=="gabriel") then
  ffu(2)=1
else if (trim(mode)=="triang") then
  ffu(2)=0
else if (trim(mode)=="extended") then
  ffu(2)=0
  ffu(23)=1
  ffu(24)=1
else if (trim(mode)=="extended_inter") then
  ffu(2)=0
  ffu(17)=1
  ffu(23)=1
  ffu(24)=1
else if (trim(mode)=="legacy_extended") then
  ffu(9)=1
  ffu(23)=1
else if (trim(mode)=="legacy_extended_inter") then
  ffu(9)=1
  ffu(17)=1
  ffu(23)=1
else if (trim(mode)=="extended_node") then
  ffu(23)=1
  ffu(24)=1
  rebuild_node=1
else if (trim(mode)=="extended_inter_node") then
  ffu(17)=1
  ffu(23)=1
  ffu(24)=1
  rebuild_node=1
else if (trim(mode)=="legacy_extended_node") then
  ffu(9)=1
  ffu(23)=1
  rebuild_node=1
else if (trim(mode)=="legacy_extended_inter_node") then
  ffu(9)=1
  ffu(17)=1
  ffu(23)=1
  rebuild_node=1
else if (trim(mode)=="legacy_gabriel") then
  ffu(9)=1
  ffu(2)=1
else
  stop 11
end if
call neighbor_build
if (rebuild_node==1) call neighbor_build_node(1)
do node_id=1,nd
  write(*,'(I0)') nneigh(node_id)
  do slot=1,nneigh(node_id)
    write(*,'(I0,1X)',advance='no') neigh(node_id,slot)
  end do
  write(*,*)
  do slot=1,nneigh(node_id)
    write(*,'(ES25.16E3,1X)',advance='no') dneigh(node_id,slot)
  end do
  write(*,*)
end do
end program neighbor_mode_reference
