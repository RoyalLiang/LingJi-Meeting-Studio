ARG BASE_IMAGE=lingji-ubuntu22-builder:20261107
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends clang lld llvm llvm-dev nsis cmake ninja-build g++-mingw-w64-i686 python3-venv unzip && rm -rf /var/lib/apt/lists/*
# Ubuntu 22.04's NSIS omits the newer Restart Manager header used by the installer.
RUN curl -fsSL --retry 3 https://raw.githubusercontent.com/NSIS-Dev/nsis/7359413009afd4f0fff472d841fc2f2cc0e0a5f8/Include/Win/RestartManager.nsh -o /usr/share/nsis/Include/Win/RestartManager.nsh && echo '67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e  /usr/share/nsis/Include/Win/RestartManager.nsh' | sha256sum -c -
RUN python3 -m venv /opt/xwin && /opt/xwin/bin/pip install --no-cache-dir cargo-xwin==0.23.1
ENV PATH=/opt/xwin/bin:/opt/node-v26.12.1-linux-x64/bin:/opt/rust/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /work
