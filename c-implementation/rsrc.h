#ifndef RSRC_H
#define RSRC_H

#include "pcb.h"

/* System totals. Check these against your course page / instructor. */
#define MAX_PRINTERS 2
#define MAX_SCANNERS 1
#define MAX_MODEMS   1
#define MAX_CDS      2

typedef struct rsrc {
    int printers, scanners, modems, cds;   /* currently available */
} Rsrc;

void rsrcInit(Rsrc *r);
int  rsrcChk(const Rsrc *r, const Pcb *p);    /* 1 if every request can be met */
void rsrcAlloc(Rsrc *r, const Pcb *p);        /* subtract the request */
void rsrcFree(Rsrc *r, const Pcb *p);         /* give it back */

#endif
