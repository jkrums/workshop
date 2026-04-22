#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

# Always ensure the /paperclip volume is writable by the node user.
# Fly volumes mount as root-owned regardless of PUID/PGID, so the
# conditional-on-remap chown above isn't sufficient.
chown node:node /paperclip
find /paperclip -mindepth 1 -maxdepth 1 ! -user node -exec chown -R node:node {} +

exec gosu node "$@"
