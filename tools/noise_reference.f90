program noise_reference
use general
use inicial
use automaticon
use model
implicit none
character*200 :: input_file
integer :: idx

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
ffu(15)=0
ffu(16)=0
delta=0.001d0
call itera
write(*,'(I0)') nd
do idx=1,nd
  write(*,'(I0,3(1X,ES25.16E3))') idx,node(idx)%x,node(idx)%y,node(idx)%z
end do
end program noise_reference
