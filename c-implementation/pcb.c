#include "pcb.h"

#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

/* ---------- FIFO queue of PCBs ---------- */

void qInit(Queue *q) { q->head = q->tail = NULL; }

int qEmpty(const Queue *q) { return q->head == NULL; }

void qPush(Queue *q, PcbPtr p) {
    p->next = NULL;
    if (q->tail) q->tail->next = p;
    else         q->head = p;
    q->tail = p;
}

PcbPtr qPop(Queue *q) {
    PcbPtr p = q->head;
    if (p) {
        q->head = p->next;
        if (!q->head) q->tail = NULL;
        p->next = NULL;
    }
    return p;
}

/* ---------- PCB and process control ---------- */

PcbPtr pcbCreate(int id, int arrival, int priority, int cpu, int mbytes,
                 int printers, int scanners, int modems, int cds) {
    PcbPtr p = calloc(1, sizeof *p);
    if (!p) { perror("calloc"); exit(1); }
    p->id = id;
    p->arrival = arrival;
    p->priority = priority;
    p->cpu = p->remaining = cpu;
    p->mbytes = mbytes;
    p->printers = printers;
    p->scanners = scanners;
    p->modems = modems;
    p->cds = cds;
    p->state = ST_NEW;
    return p;
}

int pcbStart(PcbPtr p, int verbose) {
    char idstr[16];
    snprintf(idstr, sizeof idstr, "%d", p->id);
    fflush(stdout);                       /* don't duplicate buffered output in the child */
    pid_t pid = fork();
    if (pid < 0) { perror("fork"); return -1; }
    if (pid == 0) {
        if (!verbose) {                   /* keep the dispatcher log readable */
            int fd = open("/dev/null", O_WRONLY);
            if (fd >= 0) { dup2(fd, STDOUT_FILENO); close(fd); }
        }
        execl("./sleepy", "sleepy", idstr, (char *)NULL);
        perror("execl ./sleepy");
        _exit(127);
    }
    p->pid = pid;
    p->started = 1;
    return 0;
}

void pcbSuspend(PcbPtr p) {
    int st;
    kill(p->pid, SIGTSTP);
    waitpid(p->pid, &st, WUNTRACED);      /* returns once the child is really stopped */
}

void pcbResume(PcbPtr p) { kill(p->pid, SIGCONT); }

void pcbTerminate(PcbPtr p) {
    int st;
    kill(p->pid, SIGINT);
    waitpid(p->pid, &st, 0);              /* reap so no zombie is left */
}

void pcbKill(PcbPtr p) { kill(p->pid, SIGKILL); waitpid(p->pid, NULL, 0); }
