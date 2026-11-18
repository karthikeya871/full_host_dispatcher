CC     = gcc
CFLAGS = -Wall -Wextra -g -std=gnu11
OBJS   = host.o pcb.o mab.o rsrc.o

all: host sleepy

host: $(OBJS)
	$(CC) $(CFLAGS) -o $@ $(OBJS)

sleepy: sleepy.c
	$(CC) $(CFLAGS) -o $@ sleepy.c

%.o: %.c pcb.h mab.h rsrc.h
	$(CC) $(CFLAGS) -c $<

test: all
	./host -t 100 jobs_full.txt

clean:
	rm -f host sleepy *.o
