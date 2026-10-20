program gene_reference
use general
use inicial
use automaticon
use genetic
implicit none
integer :: node_id, gene_id
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
call genestep

do node_id=1,nd
  do gene_id=1,ng
    write(*,'(I0,1X,I0,1X,ES25.16E3)') node_id,gene_id,dgex(node_id,gene_id)
  end do
end do
end program gene_reference
