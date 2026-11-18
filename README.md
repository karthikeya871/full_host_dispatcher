# HOST Dispatcher Simulator

A multilevel scheduler with memory and device allocation, written twice:

- **`c-implementation/`**: the original program in C for Linux. Every job is a real process, started with `fork`/`exec` and controlled with `SIGTSTP`, `SIGCONT` and `SIGINT`.
- **Web UI** (`index.html`, `dispatcher.js`, `app.js`, `style.css`): the same algorithm in JavaScript, with editable inputs, a step-through view and printable results. It runs entirely in the browser.

**Live demo:** `https://<your-github-username>.github.io/<repo-name>/` (see "Deploy" below)

## What it simulates

| Part | Rule |
| --- | --- |
| Real-time queue | Priority 0 jobs. First come first served. Never suspended. No devices. Own 64 MB memory. |
| User job queue | Priority 1 to 3 jobs wait here until memory **and** all devices they need are free. Only the head of the queue is considered (FIFO). |
| Feedback queues | Three queues, 1 second quantum. After each turn, if another job is waiting, the job is suspended and moved down one level. The bottom queue is Round Robin. |
| Aging (optional) | Stops starvation. A job that has waited `N` seconds in queue 1 or 2 is put back at the end of queue 0. Off by default. |
| Memory | Linked list of blocks. Allocation splits a block, freeing merges neighbours. Policies: first, next, best, worst fit. |
| Devices | Counters for printers, scanners, modems and CD drives (defaults 2, 1, 1, 2). |

Each second the dispatcher does: arrivals, admission, aging (if on), the running job's second (terminate or suspend and demote), then dispatch (real-time first, then the highest non-empty feedback queue).

### Starvation and aging

Without aging, a long job that has sunk to the bottom queue only runs when every queue above it is empty. If short jobs keep arriving, it can wait for a very long time. With aging, a job that has waited `N` seconds is moved back to the end of queue 0, so it gets the CPU again soon, and it is demoted again if it still has work left. Short jobs keep their quick turnaround, and the long job is guaranteed progress. The trade-off is that the average waiting time of the other jobs goes up a little.

Example (`c-implementation/jobs_starve.txt`, one 12 second job and short jobs arriving every 2 seconds): without aging the long job gets the CPU at seconds 0 and 2 and then waits until second 16. With aging 4 it also runs at seconds 8 and 14.

## Web UI

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000     # then open http://localhost:8000
```

You can change, and the results update immediately:

- the job list (arrival, priority, CPU time, memory, printers, scanners, modems, CDs): add, remove, sort, or paste a whole list
- user memory, real-time memory and the memory placement policy
- aging (0 turns it off)
- the total number of printers, scanners, modems and CD drives

Results: average turnaround and waiting time, execution trace, per-job times, a second-by-second view of the queues, memory blocks and free devices, and the event log. **Print results** prints the settings, job list and results on A4 landscape. **Download .txt** saves the same text the C program prints.

The page starts with one editable job and has no built-in test cases, so any job list can be tried.

## C program

```
cd c-implementation
make
./host -t 100 jobs_full.txt            # -t sets the length of one second in ms
./host -t 20 -m 1024 -p best jobs_mem.txt
./host -a 4 -t 100 jobs_starve.txt     # aging: boost jobs that wait 4 seconds
./host -d -t 300 jobs_full.txt         # dump the memory blocks every second
./host -v -t 300 jobs_full.txt         # show the output of the child processes
```

Options: `-p first|next|best|worst`, `-t ms`, `-m user_memory_mb`, `-a aging_seconds`, `-v`, `-d`. Input lines are `arrival, priority, cpu, mbytes, printers, scanners, modems, cds`. Device totals are in `rsrc.h` and the real-time memory size is `RT_MEM` in `host.c`.

| File | Purpose |
| --- | --- |
| `host.c` | Dispatcher loop, input checking, trace and statistics |
| `pcb.c`, `pcb.h` | Process control block, queues, start/suspend/resume/terminate |
| `mab.c`, `mab.h` | Memory manager |
| `rsrc.c`, `rsrc.h` | Resource manager |
| `sleepy.c` | The program each job runs (prints a line every second) |

## Limits

- Runs can last up to 200,000 simulated seconds, so a job with a burst time of 1 lakh (100,000 s) works. At most 128 jobs.
- For long runs the web page shows the first 400 seconds in the trace and the second-by-second view, and the first 500 events in the log. The averages, job times and summary always cover the whole run. **Download .txt** and **Copy as text** include every event.
- The execution trace is printed (on paper and in the text output) only for runs up to 200 seconds.
- The C program uses real time, so use a small `-t` (for example `-t 0`) for long runs.

## Tests

The JavaScript engine is checked against the C program. The test runs every `jobs_*.txt` list under all four memory policies, with aging off and on, plus 300 random job lists, and compares every event, the trace and the averages.

```
cd c-implementation && make && cd ..
node tests/parity.js
```

Expected: `0 mismatches` on the last line.

## Deploy (GitHub Pages)

The site is static, so no build step is needed.

1. Create a new repository on GitHub and push this folder to the `main` branch.
2. Open the repository, then **Settings, Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose branch `main` and folder `/ (root)`, then **Save**.
4. After about a minute the site is live at `https://<your-github-username>.github.io/<repo-name>/`.

## Assumptions and notes

- Device totals (2 printers, 1 scanner, 1 modem, 2 CDs) and the 64 MB real-time memory are assumed defaults. Both versions let you change them (the UI directly, the C program in `rsrc.h` and `host.c`).
- For the assignment's example, jobs P0 to P4 match the sample trace exactly. P5 starts at second 10, one second later than the sample trace. The written dispatcher steps run admission before termination within a second, so the memory P4 frees at second 9 is first available to admission at second 10. Running admission again after termination would give 9 for P5 but would change the rows of P3 and P4.

## License

MIT
