# jellytop: top for your Jellyfin transcodes, answered by the kernel.
#
#   make run        live view in this terminal
#   make up         install as a yeet service (restarts, comes up on boot)
#   make down       stop and remove the service
#   make dial       attach to the running service's screen
#
# Variables:
#   CONTAINER=jellyfin   the Docker container Jellyfin runs in
#   PORT=9297            where the service exposes its /tty route

CONTAINER ?= jellyfin
PORT      ?= 9297
SERVICE   := jellytop

.PHONY: run up down dial tree

run:
	yeet run ./main.tsx -- --container $(CONTAINER)

up:
	sed -e 's#^isolate = .*#isolate = "$(CURDIR)/main.tsx"#' \
	    -e 's#^\# args = .*#args = ["--container", "$(CONTAINER)"]#' \
	    -e 's#:9297/#:$(PORT)/#' jellytop.service.toml \
	  | yeet service import -n -a $(SERVICE) -
	yeet service tree $(SERVICE)

down:
	-yeet service stop $(SERVICE)
	-yeet service remove $(SERVICE)

dial:
	yeet dial ws://127.0.0.1:$(PORT)/tty

tree:
	yeet service tree $(SERVICE)
