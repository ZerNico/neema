# The Linux guest every chat's computer runs in (docs/internals/desktop.md). Commands run as
# root: the VM is the boundary, not users inside it. A release builds the desktop with the image
# of this folder, so a change here ships with a desktop release and resets every chat's installs.

FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS node
FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

FROM ubuntu:26.04@sha256:c098726dd9b9733f3e885f8de0ef375206a311b0a317eadc40d347b1115fb944

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    IS_SANDBOX=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# The nogui LibreOffice packages convert and render documents headless without pulling in a
# desktop. The fonts cover Office documents' usual faces (Carlito and Caladea are metric
# matches for Calibri and Cambria).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client socat procps less file \
      unzip zip xz-utils jq sqlite3 ripgrep tzdata \
      build-essential pkg-config \
      python3 python3-pip python3-venv python3-dev \
      pandoc poppler-utils qpdf ghostscript imagemagick ffmpeg \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-liberation fonts-dejavu-core fonts-noto-core \
      fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*

# Mounted folders belong to the person's host account, not root, and git refuses a repository
# owned by someone else. First contact with a new SSH host is trusted, per chat VM.
RUN git config --system --add safe.directory '*' \
 && git config --system init.defaultBranch main \
 && printf 'Host *\n  StrictHostKeyChecking accept-new\n' > /etc/ssh/ssh_config.d/50-sandbox.conf

# apt over HTTPS: the egress proxy grants destinations by name and port, and the built-in grants
# cover the Ubuntu archives on 443 only.
RUN sed -i 's#http://#https://#g' /etc/apt/sources.list.d/ubuntu.sources

# Layers from here on change most often (Node, then the Python lock), so a refresh downloads
# them and keeps the system layers above.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack
COPY --from=uv /uv /uvx /usr/local/bin/

# Python packages, ours and whatever the model installs with plain `pip install`, live in a
# virtualenv first on PATH: never in conflict with the system's own Python modules, which pip
# cannot replace, and no externally-managed refusal.
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
 && pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 # Commands run in a login shell, whose /etc/profile resets root's PATH.
 && printf 'export VIRTUAL_ENV=/opt/venv\nexport PATH="/opt/venv/bin:$PATH"\n' > /etc/profile.d/10-venv.sh

COPY ssh-agent-bridge /usr/local/bin/ssh-agent-bridge
COPY smoke.sh /usr/local/share/sandbox/smoke.sh

WORKDIR /workspace
CMD ["/bin/bash"]
