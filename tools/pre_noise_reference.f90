program pre_noise_reference
use general
use inicial
use automaticon
use neighboring
use genetic
use nexus
use model
use biomechanic
implicit none
character*200 :: input_file
integer :: idx
integer :: seedidx

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
getot=getot+1
do idx=1,ncels
  a=0 ; b=0 ; c=0
  do j=1,cels(idx)%nunodes
    k=cels(idx)%node(j)
    if(node(k)%tipus==1.or.node(k)%tipus==3)then
      a=a+node(k)%x ; b=b+node(k)%y ; c=c+node(k)%z
    end if
  end do
  d=1d0/real(cels(idx)%nunodes)
  if(node(cels(idx)%node(1))%tipus<3) d=2d0*d
  cels(idx)%cex=a*d ; cels(idx)%cey=b*d ; cels(idx)%cez=c*d
end do
rdiffmax=2*maxval(node(:nd)%add)*dmax
call neighbor_build
if(ffu(24)==0) call restore_neighbors
delta=deltamin
call gene_stuff
call nexe_gradual
if(ffu(12)==0)then
  call rungekutta4(delta)
else
  call adaptive_rungekutta
end if
gex(1:nd,1:ng)=agex(1:nd,1:ng)
where(gex.lt.0) gex=0.0d0
do seedidx=1,nd
  call itera
end do
call random_seed(get=idum)
write(*,'(I0)') nseed
do seedidx=1,nseed
  write(*,'(I0,1X)',advance='no') idum(seedidx)
end do
write(*,*)
do idx=1,nd
  write(*,'(I0,4(1X,ES25.16E3))') idx,node(idx)%x,node(idx)%y,node(idx)%z,node(idx)%e
end do
end program pre_noise_reference
