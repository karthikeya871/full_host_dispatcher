#include "rsrc.h"

void rsrcInit(Rsrc *r) {
    r->printers = MAX_PRINTERS;
    r->scanners = MAX_SCANNERS;
    r->modems   = MAX_MODEMS;
    r->cds      = MAX_CDS;
}

int rsrcChk(const Rsrc *r, const Pcb *p) {
    return p->printers <= r->printers && p->scanners <= r->scanners &&
           p->modems   <= r->modems   && p->cds      <= r->cds;
}

void rsrcAlloc(Rsrc *r, const Pcb *p) {
    r->printers -= p->printers;
    r->scanners -= p->scanners;
    r->modems   -= p->modems;
    r->cds      -= p->cds;
}

void rsrcFree(Rsrc *r, const Pcb *p) {
    r->printers += p->printers;
    r->scanners += p->scanners;
    r->modems   += p->modems;
    r->cds      += p->cds;
}
