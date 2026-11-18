/* The "process" the dispatcher starts. It just burns wall-clock time;
 * the dispatcher decides how long it really gets to run. */
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* The dispatcher sends SIGTSTP. Stopping ourselves with SIGSTOP keeps this
 * reliable even if the process group is orphaned (SIGTSTP's default action
 * is ignored there). */
static void onTstp(int sig) {
    (void)sig;
    raise(SIGSTOP);
}

int main(int argc, char **argv) {
    int id = argc > 1 ? atoi(argv[1]) : -1;

    signal(SIGINT, SIG_DFL);      /* background jobs may inherit SIG_IGN */
    signal(SIGTSTP, onTstp);
    setvbuf(stdout, NULL, _IOLBF, 0);

    for (int s = 1;; s++) {
        printf("    [process %d, pid %d] running, %d s so far\n", id, (int)getpid(), s);
        sleep(1);
    }
}
