#include "mab.h"

#include <stdio.h>
#include <stdlib.h>

Arena *memInit(int size, MemPolicy policy) {
    Arena *a = malloc(sizeof *a);
    MabPtr m = calloc(1, sizeof *m);
    if (!a || !m) { perror("malloc"); exit(1); }
    m->size = size;                        /* one big free block */
    a->head = a->rover = m;
    a->policy = policy;
    a->size = size;
    return a;
}

MabPtr memChk(Arena *a, int size) {
    MabPtr m, pick = NULL;
    if (size <= 0) return NULL;

    switch (a->policy) {
    case FIRST_FIT:
        for (m = a->head; m; m = m->next)
            if (!m->allocated && m->size >= size) return m;
        return NULL;

    case NEXT_FIT: {                       /* start at the rover, wrap around once */
        MabPtr start = a->rover ? a->rover : a->head;
        m = start;
        do {
            if (!m->allocated && m->size >= size) return m;
            m = m->next ? m->next : a->head;
        } while (m != start);
        return NULL;
    }

    case BEST_FIT:                         /* smallest block that fits */
        for (m = a->head; m; m = m->next)
            if (!m->allocated && m->size >= size && (!pick || m->size < pick->size))
                pick = m;
        return pick;

    case WORST_FIT:                        /* largest block that fits */
        for (m = a->head; m; m = m->next)
            if (!m->allocated && m->size >= size && (!pick || m->size > pick->size))
                pick = m;
        return pick;
    }
    return NULL;
}

MabPtr memSplit(MabPtr m, int size) {
    if (m->size > size) {
        MabPtr rest = calloc(1, sizeof *rest);
        if (!rest) { perror("calloc"); exit(1); }
        rest->offset = m->offset + size;
        rest->size = m->size - size;
        rest->prev = m;
        rest->next = m->next;
        if (m->next) m->next->prev = rest;
        m->next = rest;
        m->size = size;
    }
    return m;
}

MabPtr memAlloc(Arena *a, int size) {
    MabPtr m = memChk(a, size);
    if (!m) return NULL;
    memSplit(m, size);
    m->allocated = 1;
    a->rover = m->next ? m->next : a->head;   /* next fit continues after this block */
    return m;
}

MabPtr memMerge(Arena *a, MabPtr m) {
    MabPtr n = m->next;
    if (n && !m->allocated && !n->allocated) {
        m->size += n->size;
        m->next = n->next;
        if (n->next) n->next->prev = m;
        if (a->rover == n) a->rover = m;      /* never leave the rover on a deleted block */
        free(n);
    }
    return m;
}

MabPtr memFree(Arena *a, MabPtr m) {
    m->allocated = 0;
    memMerge(a, m);                           /* with the block after */
    if (m->prev && !m->prev->allocated)       /* with the block before */
        m = memMerge(a, m->prev);
    return m;
}

void memDump(const Arena *a) {
    printf("    offset  size  allocated\n");
    for (MabPtr m = a->head; m; m = m->next)
        printf("    %6d %5d  %s\n", m->offset, m->size, m->allocated ? "TRUE" : "FALSE");
    printf("    next-fit pointer at offset %d\n", a->rover ? a->rover->offset : 0);
}
