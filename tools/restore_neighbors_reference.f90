program restore_neighbors_reference
use general
use inicial
use neighboring
implicit none
integer :: node_id, slot, endpoint, first, second, other, shift
character*200 :: input_file
character*20 :: mode

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
call neighbor_build
call fill_co_griders
if (trim(mode)=="one") then
  second=neigh(1,1)
  do endpoint=1,2
    if (endpoint==1) then
      first=1
      other=second
    else
      first=second
      other=1
    end if
    do slot=1,nneigh(first)
      if (neigh(first,slot)==other) then
        do shift=slot,nneigh(first)-1
          neigh(first,shift)=neigh(first,shift+1)
          dneigh(first,shift)=dneigh(first,shift+1)
        end do
        nneigh(first)=nneigh(first)-1
        exit
      end if
    end do
  end do
else
  do node_id=1,nd
    nneigh(node_id)=0
  end do
end if
call restore_neighbors
do node_id=1,nd
  write(*,'(I0)') nneigh(node_id)
  do slot=1,nneigh(node_id)
    write(*,'(1X,I0)',advance='no') neigh(node_id,slot)
  end do
  write(*,*)
  do slot=1,nneigh(node_id)
    write(*,'(ES25.16E3)',advance='no') dneigh(node_id,slot)
  end do
  write(*,*)
end do
end program restore_neighbors_reference
