ARG BASE_IMAGE=lingji-ubuntu22-builder:20261107
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends clang lld llvm llvm-dev nsis cmake ninja-build g++-mingw-w64-i686 python3-venv unzip cabextract && rm -rf /var/lib/apt/lists/*
# Ubuntu 22.04's NSIS omits the newer Restart Manager header used by the installer.
RUN if ! echo '67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e  /usr/share/nsis/Include/Win/RestartManager.nsh' | sha256sum -c -; then curl -fsSL --retry 3 --connect-timeout 20 --max-time 120 https://raw.githubusercontent.com/NSIS-Dev/nsis/7359413009afd4f0fff472d841fc2f2cc0e0a5f8/Include/Win/RestartManager.nsh -o /usr/share/nsis/Include/Win/RestartManager.nsh; fi \
    && echo '67149978412da9b283e2e1abe48a360093df9caf6363373e2cabe463978b7c0e  /usr/share/nsis/Include/Win/RestartManager.nsh' | sha256sum -c -
RUN if [ ! -x /opt/xwin/bin/cargo-xwin ]; then python3 -m venv /opt/xwin && /opt/xwin/bin/pip install --no-cache-dir cargo-xwin==0.23.1; fi
RUN mkdir -p /opt/msix-sdk \
    && curl -fsSL --retry 3 --connect-timeout 20 --max-time 240 https://codeload.github.com/microsoft/msix-packaging/tar.gz/7adc5aed67a309ee77dfed45be76285bda8f738d -o /tmp/msix-sdk.tar.gz \
    && echo '74a4ebfff4ece3bec5ae5b35edb5568f85c87025fc324bbf24b1385c5fb0cdb3  /tmp/msix-sdk.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/msix-sdk.tar.gz -C /opt/msix-sdk --strip-components=1 \
    && cmake -S /opt/msix-sdk -B /opt/msix-sdk/build -DCMAKE_BUILD_TYPE=MinSizeRel -DCMAKE_TOOLCHAIN_FILE=/opt/msix-sdk/cmake/linux.cmake -DLINUX=ON -DMSIX_PACK=ON -DUSE_VALIDATION_PARSER=ON -DCMAKE_DISABLE_FIND_PACKAGE_Git=TRUE -DVERSION_MAJOR=1 -DVERSION_MINOR=7 -DVERSION_PATCH=0 \
    && cmake --build /opt/msix-sdk/build --target makemsix --parallel 4 \
    && rm /tmp/msix-sdk.tar.gz
ENV LD_LIBRARY_PATH=/opt/msix-sdk/build/lib
ENV PATH=/opt/msix-sdk/build/bin:/opt/xwin/bin:/opt/node-v26.12.1-linux-x64/bin:/opt/rust/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /work
