program force_reference
use general
use inicial
use automaticon
use biomechanic
use neighboring
implicit none
integer :: idx, jdx
character*200 :: input_file, mode

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

if (trim(mode)=="neighbors") then
  do idx=1,nd
    write(*,'(I0)') nneigh(idx)
    do jdx=1,nneigh(idx)
      write(*,'(I0,1X)',advance='no') neigh(idx,jdx)
    end do
    write(*,*)
    do jdx=1,nneigh(idx)
      write(*,'(ES25.16E3,1X)',advance='no') dneigh(idx,jdx)
    end do
    write(*,*)
  end do
else
  call forces
  do idx=1,nd
    write(*,'(I0,15(1X,ES25.16E3))') idx,px(idx),py(idx),pz(idx), &
      vsprx(idx),vspry(idx),vsprz(idx),vcilx(idx),vcily(idx),vcilz(idx), &
      vtorx(idx),vtory(idx),vtorz(idx),vstorx(idx),vstory(idx),vstorz(idx)
  end do
end if
end program force_reference
