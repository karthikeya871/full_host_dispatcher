#ifndef MAB_H
#define MAB_H

typedef enum { FIRST_FIT, NEXT_FIT, BEST_FIT, WORST_FIT } MemPolicy;

struct mab {
    int offset;
    int size;
    int allocated;
    struct mab *next;
    struct mab *prev;
};
typedef struct mab Mab;
typedef Mab *MabPtr;

/* A memory arena: a doubly linked list of blocks covering [0, size). */
typedef struct {
    MabPtr    head;
    MabPtr    rover;      /* next-fit pointer */
    MemPolicy policy;
    int       size;
} Arena;

Arena *memInit(int size, MemPolicy policy);
MabPtr memChk(Arena *a, int size);     /* block the policy would pick, or NULL */
MabPtr memAlloc(Arena *a, int size);   /* check + split + mark allocated */
MabPtr memFree(Arena *a, MabPtr m);    /* mark free, merge with free neighbours */
MabPtr memMerge(Arena *a, MabPtr m);   /* merge m with the block after it if both are free */
MabPtr memSplit(MabPtr m, int size);   /* shrink m to size, remainder becomes a free block */
void   memDump(const Arena *a);

#endif
