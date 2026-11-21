# Native (C) versions of the measurement and the covert channel.
#   make            build ./chase, ./channel and ./bandwidth
#   make test       decoder self-test + a tiny smoke sweep
CC     ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c11

all: chase channel bandwidth

chase: chase.c common.h
	$(CC) $(CFLAGS) -o $@ chase.c -lm

channel: channel.c common.h
	$(CC) $(CFLAGS) -o $@ channel.c -lm

bandwidth: bandwidth.c common.h
	$(CC) $(CFLAGS) -o $@ bandwidth.c

test: all
	./channel selftest
	./chase --min 16K --max 256K --per-octave 1 --repeats 1 --target-ms 2 > /dev/null
	./bandwidth --min 32K --max 256K --repeats 1 --target-ms 2 > /dev/null
	@echo "native tests passed"

clean:
	rm -f chase channel bandwidth

.PHONY: all test clean
