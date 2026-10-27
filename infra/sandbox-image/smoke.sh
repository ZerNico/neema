#!/bin/sh
# Checks every tool the model is told the image has. CI runs it in the built image before
# publishing; it needs no network.
set -eu
fail=0
check() {
  if out=$(sh -c "$2" 2>&1); then
    printf 'ok    %-12s %s\n' "$1" "$(printf '%s' "$out" | head -n1)"
  else
    printf 'FAIL  %-12s %s\n' "$1" "$(printf '%s' "$out" | tail -n3)"
    fail=1
  fi
}

check python "python3 --version"
check pip-libs "python3 -c 'import numpy, pandas, scipy, openpyxl, xlsxwriter, docx, pptx, pypdf, pdfplumber, reportlab, matplotlib, PIL, requests, bs4, lxml, yaml, jinja2, tabulate; print(\"imports ok\")'"
check pip "pip --version | grep -q /opt/venv && pip --version"
check login-path "bash -lc 'command -v python3' | grep -x /opt/venv/bin/python3"
check node "node --version"
check npm "npm --version"
check npx "npx --version"
check uv "uv --version"
check git "git --version"
check ssh "ssh -V"
check rg "rg --version"
check jq "jq --version"
check sqlite3 "sqlite3 --version"
check gcc "gcc --version"
check pandoc "pandoc --version"
check pdftotext "pdftotext -v"
check qpdf "qpdf --version"
check gs "gs --version"
check magick "convert -version"
check ffmpeg "ffmpeg -version"
check tesseract "tesseract --list-langs | grep -x deu"
check soffice "soffice --version"
check socat-vsock "socat -h | grep -i vsock-connect"
check bridge "test -x /usr/local/bin/ssh-agent-bridge && echo present"
check safe-dir "git config --system --get-all safe.directory"
check apt-https "! grep -q 'http://' /etc/apt/sources.list.d/ubuntu.sources && echo https-only"

# LibreOffice actually converting, not only starting: the case the model relies on.
tmp=$(mktemp -d)
printf 'a,b\n1,2\n' > "$tmp/t.csv"
check convert "cd $tmp && soffice --headless --convert-to xlsx t.csv >/dev/null && test -s t.xlsx && echo converted"
rm -rf "$tmp"

exit "$fail"
