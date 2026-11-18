#ifndef PCB_H
#define PCB_H

#include <sys/types.h>

#define N_FEEDBACK 3   /* feedback levels for user jobs (priority 1..3) */

typedef enum { ST_NEW, ST_PENDING, ST_QUEUED, ST_RUNNING, ST_SUSPENDED, ST_DONE } PState;

struct mab;            /* defined in mab.h */

struct pcb {
    int id;                    /* position in the dispatch list (0-based) */
    pid_t pid;                 /* 0 until the process is started */
    int arrival;
    int priority;              /* 0 = real-time, 1..3 = user job */
    int cpu, remaining;        /* seconds */
    int mbytes;
    int printers, scanners, modems, cds;
    int level;                 /* current feedback queue (0 = highest) */
    int queuedAt;              /* tick at which it joined its feedback queue (for aging) */
    int started;
    int finish;                /* tick at which it terminated */
    PState state;
    struct mab *mem;
    struct pcb *next;          /* queue link */
};
typedef struct pcb Pcb;
typedef Pcb *PcbPtr;

typedef struct { PcbPtr head, tail; } Queue;

void   qInit(Queue *q);
int    qEmpty(const Queue *q);
void   qPush(Queue *q, PcbPtr p);
PcbPtr qPop(Queue *q);

PcbPtr pcbCreate(int id, int arrival, int priority, int cpu, int mbytes,
                 int printers, int scanners, int modems, int cds);
int    pcbStart(PcbPtr p, int verbose);   /* fork + exec ./sleepy */
void   pcbSuspend(PcbPtr p);              /* SIGTSTP, waits until stopped */
void   pcbResume(PcbPtr p);               /* SIGCONT */
void   pcbTerminate(PcbPtr p);            /* SIGINT, then reap */
void   pcbKill(PcbPtr p);                 /* SIGKILL, cleanup only */

#endif
