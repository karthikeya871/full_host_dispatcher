/* HOST dispatcher: real-time queue + 3-level feedback queues, memory and
 * I/O resource allocation.  Usage: ./host [-p first|next|best|worst] [-t ms]
 *                                         [-m user_mem_mb] [-a aging_s] [-v] [-d] jobs.txt */
#define _POSIX_C_SOURCE 200809L
#include <ctype.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "mab.h"
#include "pcb.h"
#include "rsrc.h"

#define MAXJOBS  128
#define MAXTICKS 200000        /* longest run, in seconds */
#define TRACEW   400           /* the trace keeps only the first 400 seconds */
#define TRACE_PRINT 200        /* the trace is printed only for runs up to 200 seconds */
#define CELLW    6
#define RT_MEM   64            /* MB reserved for real-time processes */

static PcbPtr jobs[MAXJOBS];
static int    njobs;
static char   cell[MAXJOBS][TRACEW][CELLW];   /* trace: events per job per tick */

static Queue  inputQ, rtQ, userQ, fbQ[N_FEEDBACK];
static Arena *userMem, *rtMem;
static Rsrc   res;
static PcbPtr running;

static int T;                                   /* dispatcher timer */
static int tickMs = 1000, verbose, dump;
static int aging;                               /* 0 = off, else boost after this many seconds waiting */
static int userMemSize = 1024 - RT_MEM;

#define LOG(...) do { printf("[T=%2d] ", T); printf(__VA_ARGS__); printf("\n"); } while (0)

static void ev(PcbPtr p, char c) {
    if (T >= TRACEW) return;
    char *s = cell[p->id][T];
    size_t n = strlen(s);
    if (n < CELLW - 1) { s[n] = c; s[n + 1] = '\0'; }
}

static void cleanup(int sig) {                  /* Ctrl-C: don't leave children behind */
    (void)sig;
    for (int i = 0; i < njobs; i++)
        if (jobs[i]->started && jobs[i]->state != ST_DONE) pcbKill(jobs[i]);
    _exit(130);
}

static void die(const char *file, int ln, const char *msg) {
    fprintf(stderr, "%s:%d: %s\n", file, ln, msg);
    exit(1);
}

/* ---------- input ---------- */

static void loadJobs(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); exit(1); }

    char line[256];
    int ln = 0, last = 0;
    while (fgets(line, sizeof line, f)) {
        ln++;
        char *s = line;
        while (isspace((unsigned char)*s)) s++;
        if (*s == '\0' || *s == '#') continue;

        int a, pr, cpu, mb, pn, sc, mo, cd;
        if (sscanf(s, "%d , %d , %d , %d , %d , %d , %d , %d",
                   &a, &pr, &cpu, &mb, &pn, &sc, &mo, &cd) != 8)
            die(path, ln, "expected: arrival, priority, cpu, mbytes, printers, scanners, modems, cds");
        if (njobs >= MAXJOBS)                       die(path, ln, "too many jobs");
        if (a < last)                               die(path, ln, "arrival times must be in order");
        if (a < 0 || pr < 0 || pr > 3 || cpu <= 0 || mb <= 0 ||
            pn < 0 || sc < 0 || mo < 0 || cd < 0)   die(path, ln, "invalid value");
        if (pr == 0) {
            if (mb > RT_MEM)                        die(path, ln, "real-time job needs more than 64 MB");
            if (pn || sc || mo || cd)               die(path, ln, "real-time jobs cannot use I/O resources");
        } else {
            if (mb > userMemSize)                   die(path, ln, "job needs more memory than the arena has");
            if (pn > MAX_PRINTERS || sc > MAX_SCANNERS || mo > MAX_MODEMS || cd > MAX_CDS)
                                                    die(path, ln, "job needs more I/O resources than the system has");
        }
        last = a;

        PcbPtr p = pcbCreate(njobs, a, pr, cpu, mb, pn, sc, mo, cd);
        jobs[njobs++] = p;
        qPush(&inputQ, p);
    }
    fclose(f);
    if (njobs == 0) { fprintf(stderr, "%s: no jobs\n", path); exit(1); }
}

/* ---------- dispatcher steps ---------- */

static int userQueuesNonEmpty(void) {
    for (int i = 0; i < N_FEEDBACK; i++)
        if (!qEmpty(&fbQ[i])) return 1;
    return 0;
}

static int anyWaiting(void) { return !qEmpty(&rtQ) || userQueuesNonEmpty(); }

/* step ii: user job queue -> feedback queues. FIFO, all-or-nothing: the head
 * must get both its memory and its I/O resources, otherwise nothing moves. */
static void admit(void) {
    while (userQ.head) {
        PcbPtr p = userQ.head;
        if (!memChk(userMem, p->mbytes) || !rsrcChk(&res, p))
            break;
        qPop(&userQ);
        p->mem = memAlloc(userMem, p->mbytes);
        rsrcAlloc(&res, p);
        p->level = p->priority - 1;               /* priority 1 -> highest queue */
        p->state = ST_QUEUED;
        qPush(&fbQ[p->level], p);
        p->queuedAt = T;
        ev(p, 'F');
        LOG("P%d admitted: %d MB at offset %d, printers %d scanners %d modems %d cds %d -> queue %d",
            p->id, p->mbytes, p->mem->offset, p->printers, p->scanners, p->modems, p->cds, p->level);
    }
}

/* Anti-starvation: a user job that has waited `aging` seconds in feedback queue 1 or 2
 * is put back at the end of the top queue (queue 0), so it cannot wait forever. */
static void age(void) {
    if (aging <= 0) return;
    for (int lvl = 1; lvl < N_FEEDBACK; lvl++) {
        Queue keep;
        PcbPtr p;
        qInit(&keep);
        while ((p = qPop(&fbQ[lvl]))) {
            if (T - p->queuedAt >= aging) {
                LOG("P%d aged -> queue 0 (waited %d s)", p->id, T - p->queuedAt);
                p->level = 0;
                p->queuedAt = T;
                qPush(&fbQ[0], p);
            } else qPush(&keep, p);
        }
        fbQ[lvl] = keep;
    }
}

/* fill in the trace cell of every live job that had no event this tick */
static void record(void) {
    if (T >= TRACEW) return;
    for (int i = 0; i < njobs; i++) {
        PcbPtr p = jobs[i];
        char *c = cell[i][T];
        char ch;
        if (c[0] || p->state == ST_NEW || p->state == ST_DONE) continue;
        switch (p->state) {
        case ST_PENDING:   ch = 'P'; break;
        case ST_QUEUED:    ch = p->priority == 0 ? 'Q' : 'F'; break;
        case ST_RUNNING:   ch = 'R'; break;
        case ST_SUSPENDED: ch = 'S'; break;
        default:           continue;
        }
        c[0] = ch;
        c[1] = '\0';
    }
}

static void printTrace(int last) {
    if (last > TRACE_PRINT) {
        printf("\nExecution trace omitted: the run is longer than %d seconds.\n", TRACE_PRINT);
        return;
    }
    printf("\nExecution trace  (P pending, Q real-time queue, F feedback queue, R running,\n"
           "                  S suspended, | terminated)\n\n");
    printf("%-5s", "T =");
    for (int t = 0; t <= last; t++) printf("%-*d", CELLW, t);
    printf("\n");
    for (int i = 0; i < njobs; i++) {
        char lab[16];
        snprintf(lab, sizeof lab, "P%d:", i);
        printf("%-5s", lab);
        for (int t = 0; t <= last; t++) printf("%-*s", CELLW, cell[i][t]);
        printf("\n");
    }
}

static void printStats(void) {
    double tt = 0, wt = 0;
    for (int i = 0; i < njobs; i++) {
        int turn = jobs[i]->finish - jobs[i]->arrival;
        tt += turn;
        wt += turn - jobs[i]->cpu;
    }
    printf("\nAverage turnaround time: %.2f s, average waiting time: %.2f s\n",
           tt / njobs, wt / njobs);
}

static void usage(void) {
    fprintf(stderr,
            "usage: ./host [-p first|next|best|worst] [-t tick_ms] [-m user_mem_mb] [-a aging_s] [-v] [-d] jobs.txt\n"
            "  -p  memory policy (default first)    -t  length of one second in ms (default 1000)\n"
            "  -m  user memory in MB (default 960)  -v  show output of the child processes\n"
            "  -a  aging: put a job waiting this many seconds in queue 1 or 2 back in queue 0 (default off)\n"
            "  -d  dump the memory arena every tick\n");
    exit(1);
}

int main(int argc, char **argv) {
    MemPolicy pol = FIRST_FIT;
    const char *polName = "first";
    int opt;

    setvbuf(stdout, NULL, _IOLBF, 0);
    while ((opt = getopt(argc, argv, "p:t:m:a:vdh")) != -1) {
        switch (opt) {
        case 'p':
            polName = optarg;
            if      (!strcmp(optarg, "first")) pol = FIRST_FIT;
            else if (!strcmp(optarg, "next"))  pol = NEXT_FIT;
            else if (!strcmp(optarg, "best"))  pol = BEST_FIT;
            else if (!strcmp(optarg, "worst")) pol = WORST_FIT;
            else usage();
            break;
        case 't': tickMs = atoi(optarg); if (tickMs < 0) usage(); break;
        case 'm': userMemSize = atoi(optarg); if (userMemSize <= 0) usage(); break;
        case 'a': aging = atoi(optarg); if (aging < 0) usage(); break;
        case 'v': verbose = 1; break;
        case 'd': dump = 1; break;
        default:  usage();
        }
    }
    if (optind != argc - 1) usage();

    /* 1-2. initialise queues, memory, resources */
    qInit(&inputQ); qInit(&rtQ); qInit(&userQ);
    for (int i = 0; i < N_FEEDBACK; i++) qInit(&fbQ[i]);
    userMem = memInit(userMemSize, pol);
    rtMem   = memInit(RT_MEM, FIRST_FIT);
    rsrcInit(&res);

    /* 3. fill input queue from the dispatch list */
    loadJobs(argv[optind]);
    signal(SIGINT, cleanup);
    printf("HOST dispatcher: %d jobs, user memory %d MB (%s fit), real-time memory %d MB",
           njobs, userMemSize, polName, RT_MEM);
    if (aging > 0) printf(", aging %d s", aging);
    printf(", tick %d ms\n", tickMs);

    /* 4-5. main loop */
    for (T = 0;; T++) {
        if (T >= MAXTICKS - 1) { fprintf(stderr, "simulation too long\n"); cleanup(0); }

        /* i. arrivals */
        while (inputQ.head && inputQ.head->arrival <= T) {
            PcbPtr p = qPop(&inputQ);
            if (p->priority == 0) {
                p->state = ST_QUEUED;
                qPush(&rtQ, p);
                ev(p, 'Q');
                LOG("P%d arrived -> real-time queue", p->id);
            } else {
                p->state = ST_PENDING;
                qPush(&userQ, p);
                ev(p, 'P');
                LOG("P%d arrived -> user job queue", p->id);
            }
        }

        /* ii. admission */
        admit();
        age();
        if (dump) memDump(userMem);

        /* iii. the running process */
        if (running) {
            PcbPtr p = running;
            p->remaining--;
            if (p->remaining <= 0) {
                pcbTerminate(p);                              /* SIGINT */
                p->state = ST_DONE;
                p->finish = T;
                ev(p, '|');
                if (p->priority == 0) memFree(rtMem, p->mem);
                else { memFree(userMem, p->mem); rsrcFree(&res, p); }
                p->mem = NULL;
                LOG("P%d terminated, memory and resources freed", p->id);
                running = NULL;
            } else if (p->priority != 0 && anyWaiting()) {
                pcbSuspend(p);                                /* SIGTSTP */
                p->state = ST_SUSPENDED;
                ev(p, 'S');
                if (p->level < N_FEEDBACK - 1) p->level++;    /* lower its priority */
                qPush(&fbQ[p->level], p);
                p->queuedAt = T;
                LOG("P%d suspended -> queue %d", p->id, p->level);
                running = NULL;
            }
        }

        /* iv. dispatch: real-time first, then the highest non-empty feedback queue */
        if (!running) {
            PcbPtr p = NULL;
            if (!qEmpty(&rtQ)) p = qPop(&rtQ);
            else for (int i = 0; i < N_FEEDBACK && !p; i++)
                if (!qEmpty(&fbQ[i])) p = qPop(&fbQ[i]);

            if (p) {
                if (p->started) {
                    pcbResume(p);                             /* SIGCONT */
                    LOG("P%d resumed", p->id);
                } else {
                    if (p->priority == 0) p->mem = memAlloc(rtMem, p->mbytes);
                    if (pcbStart(p, verbose) < 0) cleanup(0); /* fork + exec */
                    LOG("P%d started, pid %d", p->id, (int)p->pid);
                }
                p->state = ST_RUNNING;
                ev(p, 'R');
                running = p;
            }
        }

        record();

        if (!(inputQ.head || userQ.head || rtQ.head || userQueuesNonEmpty() || running))
            break;                                            /* everything is finished */

        struct timespec ts = { tickMs / 1000, (long)(tickMs % 1000) * 1000000L };
        nanosleep(&ts, NULL);                                 /* one "second" */
    }

    printTrace(T);
    printStats();
    return 0;
}
